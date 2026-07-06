import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Covers the "reset series (wipe chapters)" action and the automatic
// on-disk → provider-volume reconcile that Refresh & Scan runs (the same
// matching as Manage Files → Auto-match), verifying a wiped series can be
// rebuilt and its existing library files re-recognised as owned.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-reset-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, getSeries, deleteChaptersForSeries, updateSeries, touchSeriesScan } = await import('../src/core/repo.js');
const { autoMapSuggestions, autoMatchSeriesFromDisk, resolveSeriesDirs } = await import('../src/core/auto-map.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

async function makeCbz(dir, name) {
  const AdmZip = (await import('adm-zip')).default;
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const zip = new AdmZip();
  zip.addFile('page001.jpg', PNG); // no ch-page names → forces volume/bare matching
  zip.writeZip(p);
  return p;
}

// Assign the 55 chapters of "Pet" across 5 volumes, 11 each — the structure the
// (fixed) provider consensus now proposes for this series.
function seedPetChapters(seriesId) {
  for (let i = 1; i <= 55; i++) {
    const vol = Math.min(5, Math.ceil(i / 11));
    upsertChapter(seriesId, { provider: 'mangadex', number: String(i), volume: String(vol) });
  }
}

test('deleteChaptersForSeries wipes every chapter row and reports the count', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'reset1', title: 'Wipe Me', language: 'en', monitored: true, packagingMode: 'volume', totalVolumesHint: 5, totalChaptersHint: 55 });
  for (let i = 1; i <= 10; i++) upsertChapter(s.id, { provider: 'mangadex', number: String(i), volume: '1' });
  assert.equal(listChaptersForSeries(s.id).length, 10);

  const removed = deleteChaptersForSeries(s.id);
  assert.equal(removed, 10);
  assert.equal(listChaptersForSeries(s.id).length, 0);
  // The series row itself survives a wipe.
  assert.ok(getSeries(s.id));
});

test('a complete wipe clears the cached hints, last-scan timestamp, and chapter-map cache (true from-scratch)', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'reset-scan', title: 'Scan Reset', language: 'en', monitored: true, packagingMode: 'volume', totalVolumesHint: 5, totalChaptersHint: 55 });
  touchSeriesScan(s.id);
  // Simulate a prior refresh having cached an external (Wikipedia/Fandom/
  // MangaUpdates) chapter map (core/chapter-map-consensus.js).
  updateSeries(s.id, { chapterMapCache: { fetchedAt: Date.now(), map: [['1', { volume: '1', source: 'wikipedia' }]], volumeTitles: [], reports: [] } });
  assert.ok(getSeries(s.id).last_scan_at, 'precondition: series has been scanned');
  assert.ok(getSeries(s.id).chapter_map_cache_json, 'precondition: chapter-map cache populated');

  // Mirror the /reset route's wipe.
  deleteChaptersForSeries(s.id);
  updateSeries(s.id, { totalVolumesHint: null, totalChaptersHint: null, lastScanAt: null, chapterMapCache: null });

  const after = getSeries(s.id);
  assert.equal(after.total_volumes_hint, null);
  assert.equal(after.total_chapters_hint, null);
  assert.equal(after.last_scan_at, null, 'next Refresh & Scan is treated as a first scan');
  assert.equal(after.chapter_map_cache_json, null, 'cached external chapter map is cleared too — no stale cross-source data survives a wipe');
});

test('autoMapSuggestions matches volume-named files to every chapter of that volume', async () => {
  const dir = path.join(tmp, 'pet-vol');
  for (let v = 1; v <= 5; v++) await makeCbz(dir, `Pet v0${v}.cbz`);

  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'reset2', title: 'Pet Vol', language: 'en', monitored: true, packagingMode: 'volume' });
  seedPetChapters(s.id);

  const { suggestions, totalFiles, matchedFiles } = await autoMapSuggestions(getSeries(s.id), dir);
  assert.equal(totalFiles, 5);
  assert.equal(matchedFiles, 5);
  assert.equal(suggestions.length, 55); // every chapter mapped to its volume file
  // Volume 3's file should own chapters 23-33.
  const v3 = suggestions.filter(sg => sg.filePath.endsWith('Pet v03.cbz')).map(sg => sg.chapterNumber).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(v3, ['23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33']);
});

test('autoMatchSeriesFromDisk marks chapters owned for bare-numbered volume files (what the library scan skips)', async () => {
  const customDir = path.join(tmp, 'pet-bare', 'Pet Bare');
  // Bare-numbered volume files with no "v"/"vol" token — the library scan
  // leaves these untouched, but auto-match resolves the trailing number as a
  // volume.
  for (let v = 1; v <= 5; v++) await makeCbz(customDir, `Pet Bare - ${v}.cbz`);

  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'reset3', title: 'Pet Bare', language: 'en', monitored: true, packagingMode: 'volume', folderPath: customDir });
  seedPetChapters(s.id);

  // The linked folder is discoverable via folder_path.
  assert.ok(resolveSeriesDirs(getSeries(s.id)).includes(customDir));

  const res = await autoMatchSeriesFromDisk(s.id);
  assert.equal(res.applied, 55);
  const chs = listChaptersForSeries(s.id);
  assert.ok(chs.every(c => c.state === 'imported'), 'all 55 chapters owned via their bare-numbered volume files');
  assert.ok(chs.find(c => c.number === '30').cbz_path.endsWith('Pet Bare - 3.cbz'));
});

test('autoMatchSeriesFromDisk never clobbers a chapter already tied to a specific file', async () => {
  const customDir = path.join(tmp, 'pet-keep', 'Pet Keep');
  await makeCbz(customDir, 'Pet Keep v01.cbz');

  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'reset4', title: 'Pet Keep', language: 'en', monitored: true, packagingMode: 'volume', folderPath: customDir });
  for (let i = 1; i <= 11; i++) upsertChapter(s.id, { provider: 'mangadex', number: String(i), volume: '1' });
  // Chapter 1 was already reconciled to a precise per-chapter file by an
  // earlier library scan — auto-match must leave it alone.
  const { setChapterState } = await import('../src/core/repo.js');
  const ch1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  setChapterState(ch1.id, 'imported', { cbz_path: '/some/precise/ch1.cbz', calculated: 0 });

  await autoMatchSeriesFromDisk(s.id);
  const after = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(after.cbz_path, '/some/precise/ch1.cbz', 'existing precise match preserved');
});
