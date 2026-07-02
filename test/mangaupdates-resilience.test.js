import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Regression for a real production report: MangaUpdates' consensus entry
// showed `"error": "no matching series found"` for Dandadan, a series
// unquestionably in MangaUpdates' database (confirmed live: exact-title hit,
// series_id 64884662872). getTotalVolumesForTitle() used to swallow *any*
// failure — a genuine empty search result, a network timeout, a 429/5xx —
// into the same bare `null`, so a transient hiccup under concurrent refresh
// load was indistinguishable from "this series doesn't exist" and silently
// dropped MangaUpdates' vote from that refresh cycle. Two independent fixes:
// apiFetch() now retries transient failures a couple of times, and
// getTotalVolumesForTitle() now lets a still-failing request propagate as a
// real exception instead of masquerading as "not found".

const { searchMangaUpdates, fetchSeriesMetadata, getTotalVolumesForTitle } = await import('../src/providers/mangaupdates.js');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function seriesSearchResponse(records) {
  return { ok: true, status: 200, json: async () => ({ results: records.map(record => ({ record })) }) };
}

test('apiFetch (via searchMangaUpdates): retries a transient network error and succeeds', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls < 3) throw new Error('ECONNRESET');
    return seriesSearchResponse([{ series_id: 1, title: 'Dandadan', url: '' }]);
  };

  const results = await searchMangaUpdates('Dandadan');
  assert.equal(calls, 3);
  assert.equal(results[0].title, 'Dandadan');
});

test('apiFetch: retries a 429/5xx response and succeeds', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
    if (calls === 2) return { ok: false, status: 503, json: async () => ({}) };
    return seriesSearchResponse([{ series_id: 1, title: 'Dandadan', url: '' }]);
  };

  const results = await searchMangaUpdates('Dandadan');
  assert.equal(calls, 3);
  assert.equal(results[0].title, 'Dandadan');
});

test('apiFetch: gives up after repeated failures and throws, rather than retrying forever', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('ECONNRESET'); };

  await assert.rejects(() => searchMangaUpdates('Dandadan'));
  assert.equal(calls, 3); // bounded retry count, not unbounded
});

test('apiFetch: a non-retryable error status (e.g. 400) fails immediately without retrying', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({}) }; };

  await assert.rejects(() => searchMangaUpdates('Dandadan'));
  assert.equal(calls, 1);
});

test('getTotalVolumesForTitle: propagates a still-failing lookup as a real error, not null', async () => {
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => getTotalVolumesForTitle('Dandadan'));
});

test('getTotalVolumesForTitle: still returns null for a genuine empty search result (not an error)', async () => {
  global.fetch = async () => seriesSearchResponse([]);
  const result = await getTotalVolumesForTitle('Some Series That Truly Is Not On MangaUpdates');
  assert.equal(result, null);
});

test('getTotalVolumesForTitle: transparently recovers via retry from a transient failure that would previously have been mislabeled "not found"', async () => {
  let calls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('series/search')) {
      calls++;
      if (calls === 1) throw new Error('ETIMEDOUT'); // the transient hiccup
      return seriesSearchResponse([{ series_id: 64884662872, title: 'Dandadan', url: '' }]);
    }
    if (u.includes('/series/64884662872')) {
      return { ok: true, status: 200, json: async () => ({ status: '24 Volumes (Ongoing)', latest_chapter: '250' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const result = await getTotalVolumesForTitle('Dandadan');
  assert.equal(result.totalVolumes, 24);
  assert.equal(result.seriesTitle, 'Dandadan');
});

test('fetchSeriesMetadata: a failing metadata fetch (after search succeeded) also propagates as a real error', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('series/search')) return seriesSearchResponse([{ series_id: 1, title: 'Dandadan', url: '' }]);
    throw new Error('ECONNRESET'); // metadata fetch keeps failing
  };
  await assert.rejects(() => getTotalVolumesForTitle('Dandadan'));
});
