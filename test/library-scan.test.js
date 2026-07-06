import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-lib-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState, updateSeries, getSeries } = await import('../src/core/repo.js');
const { chapterStagingDir } = await import('../src/download/downloader.js');
const { bindVolume } = await import('../src/core/binder.js');
const { scanLibrary, readCbzInfo } = await import('../src/core/library-scan.js');
const { getDb, closeDb } = await import('../src/core/db.js');
const AdmZip = (await import('adm-zip')).default;

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

test('scanLibrary marks chapters owned by an existing CBZ as imported', async () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: '11111111-1111-1111-1111-111111111111',
    title: 'Owned Series', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume',
  });
  for (const n of ['1', '2']) {
    upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
    const d = chapterStagingDir(s.id, n); mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, '001.png'), PNG);
    const row = listChaptersForSeries(s.id).find(c => c.number === n);
    setChapterState(row.id, 'downloaded', { staging_path: d, pages: 1 });
  }
  // Produce the real CBZ in the library.
  const res = await bindVolume(s, '1', listChaptersForSeries(s.id), {});
  assert.ok(res.path.endsWith('Owned Series Vol. 01.cbz'));

  // readCbzInfo recognises series (via mangadex Web id) + chapters from page names.
  const info = await readCbzInfo(res.path);
  assert.equal(info.mangadexId, '11111111-1111-1111-1111-111111111111');
  assert.equal(info.volume, '1');
  assert.deepEqual(info.chapters.sort(), ['1', '2']);

  // Simulate a fresh DB that doesn't yet know these are owned.
  getDb().exec("UPDATE chapters SET state='wanted', volume=NULL, calculated=0, cbz_path=NULL");

  const out = await scanLibrary({ seriesId: s.id });
  assert.equal(out.matchedFiles, 1);
  assert.equal(out.markedChapters, 2);

  const chs = listChaptersForSeries(s.id);
  for (const c of chs) {
    assert.equal(c.state, 'bindery', `ch ${c.number} should be bindery`);
    assert.equal(c.volume, '1', 'volume adopted from existing file');
    assert.ok(c.cbz_path?.endsWith('Owned Series Vol. 01.cbz'));
  }

  // Re-scan is idempotent (nothing left to mark).
  assert.equal((await scanLibrary({ seriesId: s.id })).markedChapters, 0);
});

test('scanLibrary keeps the freshly-resolved provider volume and does NOT re-stamp a stale CBZ label (the wipe+refresh "Pet" bug)', async () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: '44444444-4444-4444-4444-444444444444',
    title: 'Rematch Series', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume',
  });
  // Build a CBZ physically labelled "Vol. 03" containing chapters 60-62 (an old
  // packaging from a since-fixed mis-estimation).
  for (const n of ['60', '61', '62']) {
    upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '3' });
    const d = chapterStagingDir(s.id, n); mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, '001.png'), PNG);
    const row = listChaptersForSeries(s.id).find(c => c.number === n);
    setChapterState(row.id, 'downloaded', { staging_path: d, pages: 1 });
  }
  const res = await bindVolume(s, '3', listChaptersForSeries(s.id), {});
  const info = await readCbzInfo(res.path);
  assert.equal(info.volume, '3');
  assert.deepEqual(info.chapters.sort(), ['60', '61', '62']);

  // Simulate the post-wipe refresh: the providers now place these chapters in
  // volumes 5/5/6 (the correct, freshly-resolved structure).
  getDb().exec("UPDATE chapters SET state='wanted', cbz_path=NULL, calculated=0, volume=CASE number WHEN '62' THEN '6' ELSE '5' END WHERE series_id=" + s.id);

  const out = await scanLibrary({ seriesId: s.id });
  // The stale grouping is reported so the caller can rebuild the CBZs onto the
  // corrected volumes (the "rematch existing CBZ" step).
  assert.ok(out.driftedSeries.includes(s.id), 'series flagged for a volume-rematch repackage');

  const chs = Object.fromEntries(listChaptersForSeries(s.id).map(c => [c.number, c]));
  for (const n of ['60', '61', '62']) {
    assert.equal(chs[n].state, 'bindery', `ch ${n} owned`);
    assert.ok(chs[n].cbz_path?.endsWith('Rematch Series Vol. 03.cbz'), `ch ${n} linked to the on-disk file`);
  }
  // The provider volume wins — the stale "3" label must NOT come back.
  assert.equal(chs['60'].volume, '5', 'provider volume kept, not re-stamped to file vol 3');
  assert.equal(chs['61'].volume, '5');
  assert.equal(chs['62'].volume, '6');
});

test('scanLibrary matches foreign CBZ via parent directory name when Series tag is absent', async () => {
  const libDir = process.env.OUTPUT_DIR;
  // Series "Foreign Series" in the DB
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: '22222222-2222-2222-2222-222222222222',
    title: 'Foreign Series', authors: ['B'], language: 'en', monitored: true, packagingMode: 'volume',
  });
  // Two chapters with volume assignment
  for (const n of ['1', '2']) {
    upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  }

  // Simulate a foreign CBZ: named just "01.cbz" (no Series tag, no "Vol" keyword)
  // placed in a folder named after the series.
  const AdmZip = (await import('adm-zip')).default;
  const seriesDir = path.join(libDir, 'Foreign Series');
  mkdirSync(seriesDir, { recursive: true });
  const cbzPath = path.join(seriesDir, '01.cbz');
  const zip = new AdmZip();
  zip.addFile('page001.jpg', PNG);
  zip.writeZip(cbzPath);

  const out = await scanLibrary({ seriesId: s.id });
  assert.equal(out.matchedFiles, 1, 'should match the foreign CBZ via folder name');

  const chs = listChaptersForSeries(s.id);
  const bindery = chs.filter(c => c.state === 'bindery');
  assert.equal(bindery.length, 2, 'both chapters in volume 1 should be marked bindery');
});

test('scanLibrary ignores hidden directories (.tmp) and identifies single epub folders', async () => {
  const libDir = process.env.OUTPUT_DIR;
  const hidden = path.join(libDir, '.tmp');
  mkdirSync(hidden, { recursive: true });
  writeFileSync(path.join(hidden, 'hidden.cbz'), Buffer.from('pk'));

  const novel = path.join(libDir, 'Single Novel');
  mkdirSync(novel, { recursive: true });
  writeFileSync(path.join(novel, 'book.epub'), Buffer.from('pk'));

  const out = await scanLibrary();
  const titles = out.untracked.map(u => u.title);
  assert.ok(!titles.includes('.tmp'), '.tmp should be ignored');
  
  const novelEntry = out.untracked.find(u => u.title === 'Single Novel');
  assert.ok(novelEntry, 'Single Novel should be discovered');
  assert.equal(novelEntry.isSingleEpub, true, 'should be marked as single epub');
});

test('scanLibrary prunes missing chapter files and resets state to wanted', async () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: '33333333-3333-3333-3333-333333333333',
    title: 'Prune Series', authors: ['C'], language: 'en', monitored: true, packagingMode: 'volume',
  });
  upsertChapter(s.id, { provider: 'mangadex', number: '10', volume: '2' });
  const row = listChaptersForSeries(s.id).find(c => c.number === '10');
  const fakeCbz = path.join(process.env.OUTPUT_DIR, 'Prune Series Vol. 02.cbz');
  writeFileSync(fakeCbz, Buffer.from('pk'));
  setChapterState(row.id, 'imported', { cbz_path: fakeCbz });

  let chs = listChaptersForSeries(s.id);
  assert.equal(chs.find(c => c.number === '10').state, 'imported');

  // Now delete the file on disk outside the app
  rmSync(fakeCbz);

  // Scan library should notice missing file and revert chapter to wanted
  await scanLibrary({ seriesId: s.id });
  chs = listChaptersForSeries(s.id);
  const pruned = chs.find(c => c.number === '10');
  assert.equal(pruned.state, 'wanted');
  assert.equal(pruned.cbz_path, null);
});

test('bindVolume writes a localized volume title into ComicInfo.xml when the cached chapter map has one', async () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: '55555555-5555-5555-5555-555555555555',
    title: 'Titled Series', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume',
  });
  // Simulate a prior refresh having resolved+cached an external chapter map
  // (core/chapter-map-consensus.js) whose Wikipedia source carried a real
  // localized volume title, e.g. "Romance Dawn" for One Piece vol 1.
  updateSeries(s.id, { chapterMapCache: { fetchedAt: Date.now(), map: [], volumeTitles: [['1', 'Romance Dawn']], reports: [] } });

  const n = '1';
  upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  const d = chapterStagingDir(s.id, n); mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, '001.png'), PNG);
  const row = listChaptersForSeries(s.id).find(c => c.number === n);
  setChapterState(row.id, 'downloaded', { staging_path: d, pages: 1 });

  const res = await bindVolume(getSeries(s.id), '1', listChaptersForSeries(s.id), {});
  const zip = new AdmZip(res.path);
  const xml = zip.getEntry('ComicInfo.xml').getData().toString('utf-8');
  assert.match(xml, /<Title>Romance Dawn<\/Title>/, 'the cached wiki volume title wins over the generic auto-title');
});

