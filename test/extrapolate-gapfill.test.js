import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression: "Extrapolate up to Volume N" used to only append placeholder
// chapters PAST the current maximum chapter number, and silently no-op'd
// whenever more than 100 chapters were needed. A long licensed series whose DB
// holds only the head and tail of the run (e.g. One Piece: chapters 1-305 from
// the aggregator plus 1066+ tagged by MangaUpdates) has its max already at the
// tail, so the interior hole was never filled and the feature did nothing.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-gapfill-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { setSetting } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
setSetting('downloadsPaused', true);

// Keep everything offline (background packaging fetches volume covers).
const realFetch = global.fetch;
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

after(async () => { global.fetch = realFetch; await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

function seedHeadAndTail() {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: `gap-${Math.random()}`, title: `Gap Series ${Math.random()}`,
    language: 'en', monitored: true, packagingMode: 'volume',
  });
  // Head: chapters 1-20 with real volume tags (10 per volume).
  for (let n = 1; n <= 20; n++) {
    upsertChapter(s.id, { provider: 'mangadex', number: String(n), volume: String(n <= 10 ? 1 : 2) });
  }
  // Tail: chapters 91-100 tagged volume 10 — the DB's max chapter is already
  // at the tail, so the old "append past max" logic had nothing to append.
  for (let n = 91; n <= 100; n++) {
    upsertChapter(s.id, { provider: 'mangadex', number: String(n), volume: '10' });
  }
  return s;
}

test('extrapolate-preview counts interior missing chapters when maxVolume is set', async () => {
  const s = seedHeadAndTail();
  const res = await app.inject({ method: 'GET', url: `/api/series/${s.id}/extrapolate-preview?maxVolume=10` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Chapters 21-90 are missing → all 70 should be part of the preview pool.
  assert.equal(body.totalUnassigned, 70);
  const previewedVols = body.volumes.map(v => v.vol);
  assert.ok(previewedVols.includes('3') && previewedVols.includes('9'), `interior volumes previewed, got ${previewedVols}`);
});

test('extrapolate-volumes creates interior placeholder chapters and assigns them volumes', async () => {
  const s = seedHeadAndTail();
  const res = await app.inject({ method: 'POST', url: `/api/series/${s.id}/extrapolate-volumes`, payload: { maxVolume: 10 } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.created, 70, 'chapters 21-90 created');
  assert.equal(body.assigned, 70, 'every created chapter got an estimated volume');

  const chs = listChaptersForSeries(s.id);
  assert.equal(chs.length, 100);
  for (let n = 21; n <= 90; n++) {
    const c = chs.find(x => x.number === String(n));
    assert.ok(c, `chapter ${n} exists`);
    assert.ok(c.volume != null && c.volume !== '', `chapter ${n} has a volume`);
    const v = parseFloat(c.volume);
    assert.ok(v >= 3 && v <= 9, `chapter ${n} landed in an interior volume (got ${c.volume})`);
    assert.equal(c.state, 'wanted', 'monitor-all series queues placeholders for download');
  }
});

test('extrapolate-volumes fills well past the old 100-chapter silent cap', async () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: `gap-big-${Math.random()}`, title: `Gap Big ${Math.random()}`,
    language: 'en', monitored: true, packagingMode: 'volume',
  });
  for (let n = 1; n <= 10; n++) upsertChapter(s.id, { provider: 'mangadex', number: String(n), volume: '1' });

  const res = await app.inject({ method: 'POST', url: `/api/series/${s.id}/extrapolate-volumes`, payload: { maxVolume: 60 } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // 60 volumes × 10 ch/vol = 600 target; 590 missing — the old code refused
  // anything over 100 without telling anyone.
  assert.equal(body.created, 590);
  assert.equal(listChaptersForSeries(s.id).length, 600);
});

test('placeholders respect monitor mode and the from-volume threshold', async () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: `gap-from-${Math.random()}`, title: `Gap From ${Math.random()}`,
    language: 'en', monitored: true, packagingMode: 'volume', monitorMode: 'from', monitorFromVolume: 4,
  });
  for (let n = 1; n <= 10; n++) upsertChapter(s.id, { provider: 'mangadex', number: String(n), volume: '1' });

  const res = await app.inject({ method: 'POST', url: `/api/series/${s.id}/extrapolate-volumes`, payload: { maxVolume: 5 } });
  assert.equal(res.statusCode, 200);

  const chs = listChaptersForSeries(s.id);
  for (const c of chs.filter(x => parseFloat(x.number) > 10)) {
    const v = parseFloat(c.volume);
    if (v >= 4) assert.equal(c.state, 'wanted', `ch ${c.number} (vol ${c.volume}) ≥ threshold → queued`);
    else assert.equal(c.state, 'skipped', `ch ${c.number} (vol ${c.volume}) < threshold → skipped`);
  }
});
