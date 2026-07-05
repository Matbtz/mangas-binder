import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Re-packaging a volume used to re-read AND re-parse the shared volume CBZ once
// per chapter. extractChaptersFromArchive restores every chapter of a packaged
// volume in a single parse; verify it splits pages per chapter correctly and
// that an end-to-end re-package of a multi-chapter imported volume still works.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-repack-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { chapterStagingDir } = await import('../src/download/downloader.js');
const { extractChaptersFromArchive } = await import('../src/download/archive-downloader.js');
const { packageCompleteVolumes } = await import('../src/download/worker.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

function packagedVolumeBuffer() {
  const zip = new AdmZip();
  zip.addFile('ch0001_p001.png', PNG);
  zip.addFile('ch0001_p002.png', PNG);
  zip.addFile('ch0002_p001.png', PNG);
  zip.addFile('ComicInfo.xml', Buffer.from('<x/>'));
  return zip.toBuffer();
}

test('extractChaptersFromArchive splits a packaged volume into per-chapter staging in one pass', async () => {
  const buf = packagedVolumeBuffer();
  const extracted = await extractChaptersFromArchive(buf, 5001, ['1', '2']);
  assert.deepEqual([...extracted].sort(), ['1', '2']);

  const dir1 = chapterStagingDir(5001, '1');
  const dir2 = chapterStagingDir(5001, '2');
  assert.deepEqual(readdirSync(dir1).filter(f => f.endsWith('.png')).sort(), ['001.png', '002.png']);
  assert.deepEqual(readdirSync(dir2).filter(f => f.endsWith('.png')).sort(), ['001.png']);
});

test('extractChaptersFromArchive extracts only the requested subset', async () => {
  const extracted = await extractChaptersFromArchive(packagedVolumeBuffer(), 5002, ['2']);
  assert.deepEqual([...extracted], ['2']);
  assert.ok(existsSync(chapterStagingDir(5002, '2')));
  assert.ok(!existsSync(chapterStagingDir(5002, '1')), 'chapter 1 not extracted when not requested');
});

test('extractChaptersFromArchive returns empty for a foreign (non ch-named) archive so the caller falls back', async () => {
  const zip = new AdmZip();
  zip.addFile('page1.jpg', PNG);
  zip.addFile('page2.jpg', PNG);
  const extracted = await extractChaptersFromArchive(zip.toBuffer(), 5003, ['1']);
  assert.equal(extracted.size, 0);
});

test('re-packaging a volume whose chapters all share one imported volume CBZ still binds correctly', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'rp1', title: 'Repack One', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'completed' });

  // Build Vol01 from ch1+ch2 downloaded, then package it.
  for (const n of ['1', '2']) {
    upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
    const dir = chapterStagingDir(s.id, n);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '001.png'), PNG);
    const row = listChaptersForSeries(s.id).find(c => c.number === n);
    setChapterState(row.id, 'downloaded', { staging_path: dir, pages: 1 });
  }
  assert.equal(await packageCompleteVolumes(s.id), 1);
  const volCbz = path.join(tmp, 'out', 'Repack One', 'Repack One Vol. 01.cbz');
  assert.ok(existsSync(volCbz));

  // Both chapters become imported against the SAME volume CBZ, staging pruned —
  // exactly the case prewarmSharedArchives batches into one parse.
  for (const n of ['1', '2']) {
    const row = listChaptersForSeries(s.id).find(c => c.number === n);
    setChapterState(row.id, 'imported', { cbz_path: volCbz, staging_path: null });
    rmSync(chapterStagingDir(s.id, n), { recursive: true, force: true });
  }

  await packageCompleteVolumes(s.id, { force: true });

  const names = new AdmZip(volCbz).getEntries().filter(e => e.entryName.endsWith('.png')).map(e => e.entryName).sort();
  assert.deepEqual(names, ['ch0001_p001.png', 'ch0002_p001.png'], 'both chapters restored via the single-parse batch path');
});
