import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-pipe-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { chapterStagingDir } = await import('../src/download/downloader.js');
const { packageCompleteVolumes } = await import('../src/download/worker.js');
const { getDb, closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

function seedDownloaded(seriesId, number, volume) {
  upsertChapter(seriesId, { provider: 'mangadex', providerChapterId: 'c' + number, number, volume });
  const dir = chapterStagingDir(seriesId, number);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '001.png'), PNG);
  const row = listChaptersForSeries(seriesId).find(c => c.number === number);
  setChapterState(row.id, 'downloaded', { staging_path: dir, pages: 1 });
}

test('volume mode: packages closed volumes, holds the latest, then closes on completion', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pipe1', title: 'Pipe One', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'ongoing' });
  // tagged volumes 1,2 and an in-progress vol 3
  seedDownloaded(s.id, '1', '1'); seedDownloaded(s.id, '2', '1');
  seedDownloaded(s.id, '3', '2'); seedDownloaded(s.id, '4', '2');
  seedDownloaded(s.id, '5', '3');

  const imported = await packageCompleteVolumes(s.id);
  assert.equal(imported, 2, 'vol 1 and 2 packaged, vol 3 held');
  assert.ok(existsSync(path.join(tmp, 'out', 'Pipe One', 'Pipe One Vol. 01.cbz')));
  assert.ok(existsSync(path.join(tmp, 'out', 'Pipe One', 'Pipe One Vol. 02.cbz')));
  assert.ok(!existsSync(path.join(tmp, 'out', 'Pipe One', 'Pipe One Vol. 03.cbz')));

  getDb().prepare("UPDATE series SET status='completed' WHERE id=?").run(s.id);
  const more = await packageCompleteVolumes(s.id);
  assert.equal(more, 1, 'vol 3 packaged once series is complete');
  assert.ok(existsSync(path.join(tmp, 'out', 'Pipe One', 'Pipe One Vol. 03.cbz')));
});

test('volume mode: untagged chapters are extrapolated then packaged when closed', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pipe2', title: 'Pipe Two', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'ongoing' });
  // real vol 1 (3 ch) → chsPerVol=3; untagged 4..9 should split into est. vol2 (4-6) and vol3 (7-9)
  for (const n of ['1', '2', '3']) seedDownloaded(s.id, n, '1');
  for (const n of ['4', '5', '6', '7', '8', '9']) seedDownloaded(s.id, n, null);

  const imported = await packageCompleteVolumes(s.id);
  // vol1 (closed by vol2 existing) + vol2 (closed by vol3) packaged; est. vol3 held as latest
  assert.equal(imported, 2);
  assert.ok(existsSync(path.join(tmp, 'out', 'Pipe Two', 'Pipe Two Vol. 01.cbz')));
  assert.ok(existsSync(path.join(tmp, 'out', 'Pipe Two', 'Pipe Two Vol. 02.cbz')));
  assert.ok(!existsSync(path.join(tmp, 'out', 'Pipe Two', 'Pipe Two Vol. 03.cbz')));

  const v7 = listChaptersForSeries(s.id).find(c => c.number === '7');
  assert.equal(v7.volume, '3');
  assert.equal(v7.calculated, 1);
});
