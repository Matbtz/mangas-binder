import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Regression for the binder restoring already-`imported` chapters when packaging
// a volume that mixes them with freshly-`downloaded` ones:
//  - it must not crash on the imported chapter's missing staging dir (was ENOENT), and
//  - restoring a chapter from a multi-chapter volume CBZ must take only that
//    chapter's pages (no whole-volume duplication).

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-vrestore-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { chapterStagingDir } = await import('../src/download/downloader.js');
const { packageCompleteVolumes } = await import('../src/download/worker.js');
const { closeDb } = await import('../src/core/db.js');

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
  return row;
}

test('packaging a volume that mixes imported + downloaded chapters does not crash or duplicate pages', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'vr1', title: 'Mix One', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'completed' });

  // Build a real Vol01 CBZ from ch1 + ch2 (the "already owned" volume on disk).
  seedDownloaded(s.id, '1', '1');
  seedDownloaded(s.id, '2', '1');
  assert.equal(await packageCompleteVolumes(s.id), 1, 'vol 1 packaged initially');
  const volCbz = path.join(tmp, 'out', 'Mix One', 'Mix One Vol. 01.cbz');
  assert.ok(existsSync(volCbz));
  assert.equal(new AdmZip(volCbz).getEntries().filter(e => e.entryName.endsWith('.png')).length, 2);

  // Library-scan state: ch1 becomes `imported` (pages only inside the volume CBZ,
  // staging pruned); ch2 is a fresh re-download with staging present.
  const chs = listChaptersForSeries(s.id);
  const ch1 = chs.find(c => c.number === '1');
  const ch2 = chs.find(c => c.number === '2');
  setChapterState(ch1.id, 'imported', { cbz_path: volCbz, staging_path: null });
  rmSync(chapterStagingDir(s.id, '1'), { recursive: true, force: true });
  setChapterState(ch2.id, 'downloaded', { staging_path: chapterStagingDir(s.id, '2'), pages: 1 });

  await packageCompleteVolumes(s.id, { force: true });

  const names = new AdmZip(volCbz).getEntries().filter(e => e.entryName.endsWith('.png')).map(e => e.entryName).sort();
  assert.deepEqual(names, ['ch0001_p001.png', 'ch0002_p001.png'], 'one page per chapter, no duplication');
});
