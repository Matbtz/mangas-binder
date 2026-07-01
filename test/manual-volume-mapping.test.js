import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression: the manual volume-mapping endpoints (used from the series volume
// editor UI) used to reassign the `volume` column for chapters regardless of
// state, including chapters already packaged into a CBZ ('imported'/'bindery').
// That desyncs the DB from the file already on disk — the CBZ is still named
// and shelved under its original volume, but the chapter row (and thus
// ComicInfo/ audits) would silently start pointing at a different one.
// resolveVolumes() in mapping.js already protects packaged chapters this way;
// these endpoints should too.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-manualmap-'));
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

// Both endpoints under test call refreshSeries() at the end, which hits the
// MangaDex/MangaUpdates APIs for a real refresh. Stub fetch so the test stays
// offline and only exercises the volume-reassignment logic.
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('mangadex.org') && u.includes('/aggregate')) return { ok: true, status: 200, json: async () => ({ volumes: {} }) };
  if (u.includes('mangadex.org') && u.includes('/feed')) return { ok: true, status: 200, json: async () => ({ total: 0, data: [] }) };
  if (u.includes('mangaupdates.com')) return { ok: true, status: 200, json: async () => ({ results: [] }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

after(async () => { global.fetch = realFetch; await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

test('volume-definitions leaves already-imported/bindery chapters untouched', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'mm1', title: 'Manual Map One', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  for (const n of ['4', '5', '6']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '2' });

  const ch1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  setChapterState(ch1.id, 'imported', { volume: '1', calculated: 0, cbz_path: '/tmp/fake-vol1.cbz' });

  const res = await app.inject({
    method: 'POST',
    url: `/api/series/${s.id}/volume-definitions`,
    payload: { volumes: [{ volume: '9', from: 1, to: 6 }] },
  });
  assert.equal(res.statusCode, 200);

  const after1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(after1.volume, '1'); // untouched despite the range covering it
  assert.ok(['imported', 'bindery'].includes(after1.state)); // still packaged, not reset to wanted

  const ch4 = listChaptersForSeries(s.id).find(c => c.number === '4');
  assert.equal(ch4.volume, '9'); // not-yet-packaged chapter follows the new definition
});

test('custom-volume leaves already-imported/bindery chapters untouched', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'mm2', title: 'Manual Map Two', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });

  const ch2 = listChaptersForSeries(s.id).find(c => c.number === '2');
  setChapterState(ch2.id, 'bindery', { volume: '1', calculated: 0, cbz_path: '/tmp/fake-bindery.cbz' });

  const res = await app.inject({
    method: 'POST',
    url: `/api/series/${s.id}/custom-volume`,
    payload: { volume: '5', from: 1, to: 3 },
  });
  assert.equal(res.statusCode, 200);

  const after2 = listChaptersForSeries(s.id).find(c => c.number === '2');
  assert.equal(after2.volume, '1'); // untouched
  assert.equal(after2.state, 'bindery');

  const ch1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(ch1.volume, '5');
});
