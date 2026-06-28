import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression for monitor_mode='from': chapters that arrive without a volume are
// skipped (the threshold can't be judged yet) and must be re-evaluated on a later
// refresh once their real volume is tagged — otherwise `from` mode silently
// under-downloads everything MangaDex tags late.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-from-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded, setProviderEnabled } = await import('../src/core/settings.js');
const { createSeries, listChaptersForSeries } = await import('../src/core/repo.js');
const { refreshSeries } = await import('../src/core/series-service.js');
const { provider: mangadex } = await import('../src/providers/mangadex.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
setProviderEnabled('mangaupdates', false); // avoid network enrichment
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

// First refresh: provider reports no volumes (MangaDex tags late).
// Second refresh: the same chapters now carry real volumes 1,1,2,2,3,3.
let withVolumes = false;
mangadex.listChapters = async () => {
  const vols = withVolumes ? ['1', '1', '2', '2', '3', '3'] : [null, null, null, null, null, null];
  return ['1', '2', '3', '4', '5', '6'].map((n, i) => ({ id: 'c' + n, number: n, volume: vols[i], title: 'Chapter ' + n, lang: 'en' }));
};

test("monitor_mode='from' promotes chapters once their volume is tagged >= threshold", async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'mf1', title: 'From Series', authors: ['A'], language: 'en', monitored: true, monitorMode: 'from', monitorFromVolume: 3, packagingMode: 'volume', status: 'ongoing', coverPath: 'x' });

  await refreshSeries(s.id);
  assert.ok(listChaptersForSeries(s.id).every(c => c.state === 'skipped'), 'all skipped while volumes are unknown');

  withVolumes = true;
  await refreshSeries(s.id);
  const byNum = Object.fromEntries(listChaptersForSeries(s.id).map(c => [c.number, c.state]));
  assert.equal(byNum['1'], 'skipped', 'vol 1 < threshold stays skipped');
  assert.equal(byNum['4'], 'skipped', 'vol 2 < threshold stays skipped');
  assert.equal(byNum['5'], 'wanted', 'vol 3 promoted to wanted');
  assert.equal(byNum['6'], 'wanted', 'vol 3 promoted to wanted');
});
