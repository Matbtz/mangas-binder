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

test('volume mode: packages a volume when a higher volume is known but not downloaded', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pipe3', title: 'Pipe Three', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'ongoing' });
  // Vol 1 is downloaded
  seedDownloaded(s.id, '1', '1');
  seedDownloaded(s.id, '2', '1');
  // Vol 2 is known (wanted) but NOT downloaded
  upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'c3', number: '3', volume: '2' });

  const imported = await packageCompleteVolumes(s.id);
  assert.equal(imported, 1, 'vol 1 is packaged because vol 2 is known');
  assert.ok(existsSync(path.join(tmp, 'out', 'Pipe Three', 'Pipe Three Vol. 01.cbz')));
  assert.ok(!existsSync(path.join(tmp, 'out', 'Pipe Three', 'Pipe Three Vol. 02.cbz')));
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

test('upsertChapter language prioritization and upgrade resets', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'lang-test', title: 'Lang Test', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'ongoing' });
  
  // 1. Initial upsert with Spanish 'es'
  upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'ch1-es', number: '1', language: 'es', volume: '1', title: 'Capitulo 1', pages: 10 }, 'wanted');
  
  let list = listChaptersForSeries(s.id);
  let ch = list.find(c => c.number === '1');
  assert.ok(ch);
  assert.equal(ch.language, 'es');
  assert.equal(ch.state, 'wanted');
  assert.equal(ch.title, 'Capitulo 1');
  assert.equal(ch.pages, 10);

  // Mark it as downloaded
  setChapterState(ch.id, 'downloaded', { attempts: 1, error: 'none', cbz_path: 'path.cbz' });
  ch = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(ch.state, 'downloaded');

  // 2. Upsert the same chapter with English 'en'
  upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'ch1-en', number: '1', language: 'en', volume: '1', title: 'Chapter 1', pages: 12 }, 'wanted');
  
  list = listChaptersForSeries(s.id);
  assert.equal(list.length, 1, 'Should only have 1 chapter row for number 1, no duplicate Spanish row');
  ch = list[0];
  assert.equal(ch.language, 'en');
  assert.equal(ch.state, 'wanted', 'State should be reset to wanted on language upgrade');
  assert.equal(ch.attempts, 0, 'Attempts should be reset to 0');
  assert.equal(ch.error, null, 'Error should be reset to null');
  assert.equal(ch.cbz_path, null, 'cbz_path should be reset to null');
  assert.equal(ch.pages, 12);
  assert.equal(ch.title, 'Chapter 1');
});

test('staging & bindery lifecycle: packaging moves to bindery, scan imports and prunes staging', async () => {
  const { scanLibrary } = await import('../src/core/library-scan.js');
  const { setSetting } = await import('../src/core/settings.js');
  const { renameSync } = await import('fs');
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'bindery-lifecycle',
    title: 'Lifecycle Series', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'completed'
  });

  const booksDir = path.join(tmp, 'books');
  mkdirSync(booksDir, { recursive: true });
  setSetting('libraryScanDirs', `${process.env.OUTPUT_DIR},${booksDir}`);

  // Seed chapter 1 as downloaded
  seedDownloaded(s.id, '1', '1');
  const sDir = chapterStagingDir(s.id, '1');
  assert.ok(existsSync(sDir), 'staging folder should exist initially');

  // Package the completed volume
  const packaged = await packageCompleteVolumes(s.id);
  assert.equal(packaged, 1, 'should package 1 volume');

  // Verify it is in 'bindery' state and staging still exists
  let ch = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(ch.state, 'bindery', 'chapter should be in bindery state after packaging');
  assert.ok(existsSync(sDir), 'staging folder should still exist while in bindery state');

  // Move the packaged CBZ from bindery/output folder to the books folder (simulating Tome import)
  const binderyCbzPath = ch.cbz_path;
  const filename = path.basename(binderyCbzPath);
  const booksSeriesDir = path.join(booksDir, 'Lifecycle Series');
  mkdirSync(booksSeriesDir, { recursive: true });
  const booksCbzPath = path.join(booksSeriesDir, filename);
  renameSync(binderyCbzPath, booksCbzPath);

  // Run library scan (it scans outputDir + booksDir)
  const scanResult = await scanLibrary({ seriesId: s.id });
  assert.equal(scanResult.markedChapters, 1, 'scanner should detect and mark 1 chapter as imported');

  // Verify it is now 'imported' and staging is pruned
  ch = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(ch.state, 'imported', 'chapter state should become imported');
  assert.ok(!existsSync(sDir), 'staging folder should have been pruned after import');
});

test('unmonitored series are excluded from download queue and cancelSeries cancels wanted chapters', async () => {
  const { chaptersInState, updateSeries } = await import('../src/core/repo.js');
  const { cancelSeries } = await import('../src/download/worker.js');
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'unmonitored-queue-test',
    title: 'Unmonitored Series', authors: ['A'], language: 'en', monitored: true, monitorMode: 'all', packagingMode: 'volume'
  });
  upsertChapter(s.id, { provider: 'mangadex', number: '100', volume: '10' });
  let wanted = chaptersInState('wanted');
  assert.ok(wanted.some(c => c.series_id === s.id), 'should be in wanted list when monitored');

  // Set monitorMode to none
  updateSeries(s.id, { monitorMode: 'none' });
  wanted = chaptersInState('wanted');
  assert.ok(!wanted.some(c => c.series_id === s.id), 'should be excluded from wanted list when monitor_mode is none');

  // Also verify cancelSeries reverts remaining active chapters
  await cancelSeries(s.id);
  const ch = listChaptersForSeries(s.id).find(c => c.number === '100');
  assert.equal(ch.state, 'skipped', 'cancelSeries should mark wanted chapter as skipped');
});



