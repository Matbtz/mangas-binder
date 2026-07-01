import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// The CBZ-integrity audit already compared "chapters inside the file" against
// "chapters the DB maps to that file". This closes the remaining gap: a chapter
// can be correctly mapped to a file that is nonetheless *stale* — its current
// distribution (chapters.volume) has moved on since the file was bound, because
// upsertChapter/resolveVolumes only protect a volume tag once it's authoritative,
// not from the moment a chapter is packaged. The audit should catch that drift,
// and fix-stale-volumes should repackage it.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-staleaudit-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { setSetting } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
setSetting('downloadsPaused', true);
after(async () => { await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

test('audit-cbz-integrity reports a chapter whose distribution moved on without repackaging', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'sv1', title: 'Stale One', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'ongoing' });

  const seriesDir = path.join(tmp, 'out', 'Stale One');
  mkdirSync(seriesDir, { recursive: true });
  const cbz = path.join(seriesDir, 'Stale One Vol. 01.cbz');
  const zip = new AdmZip();
  zip.addFile('ch0005_p001.png', PNG);
  zip.writeZip(cbz);

  upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'c5', number: '5', volume: '1' }, 'imported');
  const ch5 = listChaptersForSeries(s.id).find(c => c.number === '5');
  setChapterState(ch5.id, 'imported', { cbz_path: cbz });
  // Simulate a later refresh correcting the distribution without repackaging —
  // exactly what upsertChapter does today for a chapter that was still
  // `calculated` when it was bound.
  setChapterState(ch5.id, 'imported', { volume: '2', calculated: 0 });

  const report = (await app.inject({ method: 'POST', url: '/api/audit-cbz-integrity' })).json();
  const file = report.results.flatMap(r => r.files)[0];
  assert.ok(file, 'file flagged with an issue');
  assert.deepEqual(file.staleVolumeChapters, [{ number: '5', currentVolume: '2', packagedVolume: '1' }]);
  assert.ok(file.issues.some(i => i.includes('package is stale')));
});

test('fix-stale-volumes repackages the corrected distribution and reports the orphaned old file', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'sv2', title: 'Stale Two', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'completed' });

  const seriesDir = path.join(tmp, 'out', 'Stale Two');
  mkdirSync(seriesDir, { recursive: true });
  const oldCbz = path.join(seriesDir, 'Stale Two Vol. 01.cbz');
  const zip = new AdmZip();
  zip.addFile('ch0005_p001.png', PNG);
  zip.writeZip(oldCbz);

  upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'c5', number: '5', volume: '1' }, 'imported');
  const ch5 = listChaptersForSeries(s.id).find(c => c.number === '5');
  setChapterState(ch5.id, 'imported', { cbz_path: oldCbz, volume: '2', calculated: 0 });

  await app.inject({ method: 'POST', url: '/api/audit-cbz-integrity' });
  const fix = (await app.inject({ method: 'POST', url: '/api/audit/fix-stale-volumes' })).json();

  assert.equal(fix.repackagedSeries, 1);
  assert.ok(fix.orphanedFiles.includes(oldCbz), 'old Vol. 01 file has no chapter pointing at it anymore');

  const after5 = listChaptersForSeries(s.id).find(c => c.number === '5');
  assert.ok(after5.cbz_path?.endsWith('Stale Two Vol. 02.cbz'), 'chapter repackaged into the correct volume file');
  assert.equal(after5.state, 'bindery');
  assert.ok(existsSync(path.join(tmp, 'out', 'Stale Two', 'Stale Two Vol. 02.cbz')));
});
