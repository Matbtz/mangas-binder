import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Regression for a real production bug: three unrelated followed series
// (Sakamoto Days, One Piece, Dandadan) all got the identical "chapter 10 ->
// vol 3 / chapter 54 -> vol 2 / chapter 69 -> vol 3" override applied, which
// is only possible if MangaUpdates' /releases/search ignored our series
// filter and returned some generic/most-recent release feed instead of
// results scoped to the requested series. fetchChapterVolumeMap() must now
// verify every record against the series id/title before trusting it, and
// report how many records were checked/verified/rejected so a misbehaving
// endpoint is visible instead of silently corrupting another series' data.

const { fetchChapterVolumeMap } = await import('../src/providers/mangaupdates.js');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function releasesPage(records) {
  return { ok: true, status: 200, json: async () => ({ results: records.map(record => ({ record })) }) };
}

test('fetchChapterVolumeMap: rejects generic/unrelated releases when the id/title do not match the target series', async () => {
  // Simulates the observed bug: the endpoint ignores our series filter and
  // always returns the same handful of "generic" releases regardless of which
  // series id we asked for.
  global.fetch = async () => releasesPage([
    { series_id: 999999, series_name: 'Some Unrelated Series', chapter: '10', volume: '3' },
    { series_id: 999999, series_name: 'Some Unrelated Series', chapter: '54', volume: '2' },
    { series_id: 999999, series_name: 'Some Unrelated Series', chapter: '69', volume: '3' },
  ]);

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(12345, 'Sakamoto Days');
  assert.equal(map.size, 0);
  assert.equal(checked, 3);
  assert.equal(verified, 0);
  assert.equal(rejected, 3);
});

test('fetchChapterVolumeMap: accepts releases verified by numeric series id', async () => {
  global.fetch = async () => releasesPage([
    { series_id: 12345, chapter: '10', volume: '2' },
    { series_id: 999999, chapter: '11', volume: '99' }, // unrelated, must be dropped
  ]);

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(12345, 'Sakamoto Days');
  assert.equal(map.get('10'), '2');
  assert.equal(map.has('11'), false);
  assert.equal(checked, 2);
  assert.equal(verified, 1);
  assert.equal(rejected, 1);
});

test('fetchChapterVolumeMap: falls back to fuzzy title match when no numeric series id is present', async () => {
  global.fetch = async () => releasesPage([
    { series: { name: 'Sakamoto Days' }, chapter: '20', volume: '3' },
    { series: { name: 'A Completely Different Manga' }, chapter: '21', volume: '4' },
  ]);

  const { map, verified, rejected } = await fetchChapterVolumeMap(12345, 'Sakamoto Days');
  assert.equal(map.get('20'), '3');
  assert.equal(map.has('21'), false);
  assert.equal(verified, 1);
  assert.equal(rejected, 1);
});

test('fetchChapterVolumeMap: fails closed (keeps nothing) when a record has no verifiable series field at all', async () => {
  global.fetch = async () => releasesPage([
    { chapter: '5', volume: '1' }, // no series id, no title — cannot be verified
  ]);

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(12345, 'Sakamoto Days');
  assert.equal(map.size, 0);
  assert.equal(checked, 1);
  assert.equal(verified, 0);
  assert.equal(rejected, 1);
});

test('fetchChapterVolumeMap: bails out early on an unfiltered firehose instead of paging through 10,000 records', async () => {
  // Reproduces a real production report: with the series filter ignored, every
  // page keeps coming back full (100 records) of entirely unrelated releases,
  // so the old 100-page ceiling meant checking 10,000 records and taking over
  // two minutes per refresh for a handful (or zero) of actual matches. It
  // must now stop after a couple of pages that verify nothing rather than
  // exhausting the full cap.
  let pagesFetched = 0;
  global.fetch = async () => {
    pagesFetched++;
    const records = Array.from({ length: 100 }, (_, i) => ({
      series_id: 999999, series_name: 'Some Unrelated Series', chapter: String(i + 1), volume: '1',
    }));
    return releasesPage(records);
  };

  const start = Date.now();
  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(12345, 'Sakamoto Days');
  const elapsedMs = Date.now() - start;

  assert.equal(map.size, 0);
  assert.equal(verified, 0);
  assert.equal(rejected, checked);
  assert.ok(pagesFetched <= 3, `expected an early bail-out, but fetched ${pagesFetched} pages`);
  assert.ok(checked <= 300, `expected far fewer than 10,000 records checked, got ${checked}`);
  assert.ok(elapsedMs < 2000, `expected this to resolve in well under a second of artificial delay, took ${elapsedMs}ms`);
});
