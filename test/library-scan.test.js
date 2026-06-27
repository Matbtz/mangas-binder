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
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { chapterStagingDir } = await import('../src/download/downloader.js');
const { bindVolume } = await import('../src/core/binder.js');
const { scanLibrary, readCbzInfo } = await import('../src/core/library-scan.js');
const { getDb, closeDb } = await import('../src/core/db.js');

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
    assert.equal(c.state, 'imported', `ch ${c.number} should be imported`);
    assert.equal(c.volume, '1', 'volume adopted from existing file');
    assert.ok(c.cbz_path?.endsWith('Owned Series Vol. 01.cbz'));
  }

  // Re-scan is idempotent (nothing left to mark).
  assert.equal((await scanLibrary({ seriesId: s.id })).markedChapters, 0);
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
  const imported = chs.filter(c => c.state === 'imported');
  assert.equal(imported.length, 2, 'both chapters in volume 1 should be marked imported');
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

