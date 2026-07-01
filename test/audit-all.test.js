import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// /api/audit-all used to run its own hand-rolled span/overlap heuristic on
// chapters.volume; it now reuses extrapolate.js's sanitizeVolumeMap so this
// audit can never disagree with what resolveVolumes would actually do.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-auditall-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { createSeries, upsertChapter } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
after(async () => { await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

test('audit-all flags the screenshot-style overlap case', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'aa1', title: 'Audit All Overlap', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume' });
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  for (const n of range(1, 7)) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  for (const n of [...range(8, 16), '54']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '2' });
  for (const n of range(17, 25)) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '3' });

  const res = (await app.inject({ method: 'GET', url: '/api/audit-all' })).json();
  const series = res.results.find(r => r.seriesTitle === 'Audit All Overlap');
  assert.ok(series, 'flagged');
  assert.ok(series.anomalies[0].includes('54'), 'names the offending chapter');
});

test('audit-all stays silent on a clean, monotonic distribution', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'aa2', title: 'Audit All Clean', authors: ['A'], language: 'en', monitored: true, packagingMode: 'volume' });
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  for (const n of range(1, 9)) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  for (const n of range(10, 18)) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '2' });

  const res = (await app.inject({ method: 'GET', url: '/api/audit-all' })).json();
  assert.equal(res.results.find(r => r.seriesTitle === 'Audit All Clean'), undefined);
});
