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
  const info = readCbzInfo(res.path);
  assert.equal(info.mangadexId, '11111111-1111-1111-1111-111111111111');
  assert.equal(info.volume, '1');
  assert.deepEqual(info.chapters.sort(), ['1', '2']);

  // Simulate a fresh DB that doesn't yet know these are owned.
  getDb().exec("UPDATE chapters SET state='wanted', volume=NULL, calculated=0, cbz_path=NULL");

  const out = scanLibrary({ seriesId: s.id });
  assert.equal(out.matchedFiles, 1);
  assert.equal(out.markedChapters, 2);

  const chs = listChaptersForSeries(s.id);
  for (const c of chs) {
    assert.equal(c.state, 'imported', `ch ${c.number} should be imported`);
    assert.equal(c.volume, '1', 'volume adopted from existing file');
    assert.ok(c.cbz_path?.endsWith('Owned Series Vol. 01.cbz'));
  }

  // Re-scan is idempotent (nothing left to mark).
  assert.equal(scanLibrary({ seriesId: s.id }).markedChapters, 0);
});
