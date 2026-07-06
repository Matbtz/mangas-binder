import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Regression for the CBZ-integrity audit + fixer being decoupled from the exact
// English issue wording: the audit emits a structured `missingChapters` list and
// `fix-missing` resets those chapters from it (not by regex-parsing display text).

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-auditfix-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { setSetting } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
setSetting('downloadsPaused', true); // keep requeued chapter in `wanted` (don't let the worker grab it)
after(async () => { await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

test('audit reports a missing chapter structurally and fix-missing requeues it', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'af1', title: 'Audit Series', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'ongoing' });

  // A volume CBZ on disk that contains chapter 1 only — chapter 2 is missing inside it.
  const seriesDir = path.join(tmp, 'out', 'Audit Series');
  mkdirSync(seriesDir, { recursive: true });
  const cbz = path.join(seriesDir, 'Audit Series Vol. 01.cbz');
  const zip = new AdmZip();
  zip.addFile('ch0001_p001.png', PNG);
  zip.writeZip(cbz);

  // Both ch1 and ch2 are registered as imported pointing at that CBZ.
  for (const n of ['1', '2']) upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'c' + n, number: n, volume: '1' }, 'imported');
  for (const r of listChaptersForSeries(s.id)) setChapterState(r.id, 'imported', { cbz_path: cbz });

  const report = (await app.inject({ method: 'POST', url: '/api/audit-cbz-integrity' })).json();
  const file = report.results.flatMap(r => r.files)[0];
  assert.deepEqual(file.missingChapters, ['2'], 'structured field lists chapter 2 as missing');

  const fix = (await app.inject({ method: 'POST', url: '/api/audit/fix-missing' })).json();
  assert.equal(fix.fixedCount, 1, 'one chapter fixed');

  const ch2 = listChaptersForSeries(s.id).find(c => c.number === '2');
  assert.equal(ch2.state, 'wanted', 'chapter 2 reset to wanted for redownload');
});

// Regression: a volume CBZ on disk can legitimately contain a chapter that was
// added to the series' chapter distribution *after* the file was last scanned
// (e.g. the provider's chapter list grew). The audit must reconcile against the
// library before diffing, so an unscanned-but-already-present chapter doesn't
// get misreported as "present in CBZ but not mapped in database".
test('audit reconciles newly distributed chapters against the library before flagging mismatches', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'af2', title: 'Redistributed Series', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume', status: 'ongoing' });

  const seriesDir = path.join(tmp, 'out', 'Redistributed Series');
  mkdirSync(seriesDir, { recursive: true });
  const cbz = path.join(seriesDir, 'Redistributed Series Vol. 01.cbz');
  const zip = new AdmZip();
  zip.addFile('ch0001_p001.png', PNG);
  zip.addFile('ch0002_p001.png', PNG);
  zip.writeZip(cbz);

  // Only chapter 1 is registered & mapped to the file; chapter 2 was just added
  // to the series' distribution (e.g. by a provider refresh) and hasn't been
  // reconciled against the library yet, even though it's already in the CBZ.
  upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'r1', number: '1', volume: '1' }, 'imported');
  upsertChapter(s.id, { provider: 'mangadex', providerChapterId: 'r2', number: '2', volume: '1' }, 'wanted');
  const ch1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  setChapterState(ch1.id, 'imported', { cbz_path: cbz });

  const report = (await app.inject({ method: 'POST', url: '/api/audit-cbz-integrity' })).json();
  const series = report.results.find(r => r.seriesTitle === 'Redistributed Series');
  assert.equal(series, undefined, 'no issues once the library scan reconciles chapter 2 to the existing file');

  const ch2 = listChaptersForSeries(s.id).find(c => c.number === '2');
  assert.equal(ch2.state, 'bindery', 'chapter 2 reconciled to the on-disk CBZ');
  assert.ok(ch2.cbz_path?.endsWith('Redistributed Series Vol. 01.cbz'));
});
