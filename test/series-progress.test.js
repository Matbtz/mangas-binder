import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The detail page's live "tick" polls a slim progress feed instead of the full
// series payload. Verify the endpoint returns only the fields the tick needs
// (states/progress + counts) and stays in sync with chapter state changes.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-progress-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
after(async () => { await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

test('GET /api/series/:id/progress returns slim chapter fields + state counts', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pg1', title: 'Progress One', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  const ch1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  setChapterState(ch1.id, 'downloading', { prog_done: 3, prog_total: 10 });

  const res = await app.inject({ method: 'GET', url: `/api/series/${s.id}/progress` });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.counts.wanted, 2);
  assert.equal(body.counts.downloading, 1);
  assert.equal(body.chapters.length, 3);

  const c1 = body.chapters.find(c => c.number === '1');
  assert.deepEqual(Object.keys(c1).sort(), ['cbzPath', 'error', 'id', 'number', 'progDone', 'progTotal', 'state', 'volume']);
  assert.equal(c1.state, 'downloading');
  assert.equal(c1.progDone, 3);
  assert.equal(c1.progTotal, 10);
  // Heavier fields the full view carries must NOT be here.
  for (const k of ['title', 'language', 'pages', 'scanQuality', 'attempts', 'publishedAt']) {
    assert.ok(!(k in c1), `slim payload must omit "${k}"`);
  }
});

test('GET /api/series/:id/progress 404s for an unknown series', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/series/999999/progress' });
  assert.equal(res.statusCode, 404);
});
