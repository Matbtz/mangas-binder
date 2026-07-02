import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Regression history for a real production bug chain:
//
// 1. Three unrelated followed series (Sakamoto Days, One Piece, Dandadan) all
//    got the identical "chapter 10 -> vol 3 / chapter 54 -> vol 2 / chapter
//    69 -> vol 3" override, which is only possible if MangaUpdates'
//    /releases/search ignored our series filter and returned some
//    generic/most-recent release feed instead of results scoped to the
//    requested series.
// 2. A first fix added per-record verification (drop anything that can't be
//    confirmed against the target series) but guessed the request-side
//    filter shape (`{ series: [id], perpage, page }`) without ever
//    confirming it against the real API.
// 3. Live testing then showed the guessed filter still returned an
//    unfiltered 10,000-record feed (10,000 checked for 6 verified matches,
//    2+ minutes per refresh).
// 4. A second fix capped pagination as a band-aid, without addressing why
//    the filter never worked.
//
// Empirical testing against the live API (see PR description for the full
// request/response evidence) found the actual root cause: `/releases/search`
// has *no* series-id filter at all — `series_id`, `series: [id]`,
// `series: { id }`, and even nonsense field names all return the exact same
// unfiltered feed. The only parameter that meaningfully narrows results is a
// free-text `search` (title) query, which is a fuzzy/tokenized pre-filter,
// not an exact scope — real "Death Note" search results included ~100
// unrelated "Death Note dj - <name>" fan-doujinshi entries. So
// fetchChapterVolumeMap() now sends `search`/`stype` instead of a
// series-id-shaped filter, and per-record verification (now the *sole*
// verification mechanism, since real release records carry no series-id
// field at all) was tightened from the shared titlesMatch()'s
// startsWith-tolerant fallback to strict normalized-title equality, since
// that leniency is exactly what let "Death Note dj - Light Note" match
// "Death Note".
//
// Fixture shapes below mirror the real /v1/releases/search response
// structure observed live: `record.title` is the plain series title (no
// nested `series` object, no `series_id` field at all in practice); `volume`
// is frequently `null` or `""` even for verified matches, since MangaUpdates
// only tags a release with a volume once it's been compiled into one.

const { fetchChapterVolumeMap } = await import('../src/providers/mangaupdates.js');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function releasesPage(records) {
  return { ok: true, status: 200, json: async () => ({ results: records.map(record => ({ record })) }) };
}

test('fetchChapterVolumeMap: sends a title search, not a series-id filter (the id/series params were confirmed to be silently ignored by the live API)', async () => {
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return releasesPage([]);
  };

  await fetchChapterVolumeMap(64884662872, 'Dandadan');

  assert.equal(capturedBody.search, 'Dandadan');
  assert.equal('series' in capturedBody, false);
  assert.equal('series_id' in capturedBody, false);
});

test('fetchChapterVolumeMap: returns immediately without a network call when no title is available', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return releasesPage([]); };

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(64884662872, null);

  assert.equal(fetchCalled, false);
  assert.equal(map.size, 0);
  assert.equal(checked, 0);
  assert.equal(verified, 0);
  assert.equal(rejected, 0);
});

test('fetchChapterVolumeMap: accepts real-shape records (bare `title`, no series/series_id field) that match the expected title', async () => {
  // Mirrors the real API response shape for a title-search hit: no
  // series/series_id field at all, just a plain `title` string.
  global.fetch = async () => releasesPage([
    { title: 'Dandadan', chapter: '10', volume: '2' },
    { title: 'Dandadan', chapter: '54', volume: null }, // real records frequently have no volume tag yet
    { title: 'Dandadan', chapter: '69', volume: '' },
  ]);

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(64884662872, 'Dandadan');
  assert.equal(map.get('10'), '2');
  assert.equal(map.has('54'), false); // no volume tag -> nothing to map
  assert.equal(map.has('69'), false);
  assert.equal(checked, 3);
  assert.equal(verified, 3); // all three verified as Dandadan; only one had usable volume data
  assert.equal(rejected, 0);
});

test('fetchChapterVolumeMap: rejects unrelated titles pulled in by the fuzzy search pre-filter', async () => {
  // Reproduces the observed bug: /releases/search ignores any series
  // filter and would return a generic firehose if given series_id/series
  // params; even with the fixed `search` text query, the match is
  // word-tokenized/fuzzy, so unrelated titles sharing a word can appear
  // (e.g. searching "One Piece" surfaces "One Hundred Storey Tower").
  global.fetch = async () => releasesPage([
    { title: 'Futoku no Guild', chapter: '10', volume: '3' },
    { title: 'One Hundred Storey Tower', chapter: '54', volume: '2' },
    { title: 'Some Unrelated Series', chapter: '69', volume: '3' },
  ]);

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(12345, 'One Piece');
  assert.equal(map.size, 0);
  assert.equal(checked, 3);
  assert.equal(verified, 0);
  assert.equal(rejected, 3);
});

test('fetchChapterVolumeMap: rejects doujinshi spinoffs that the shared fuzzy titlesMatch() would have incorrectly accepted', async () => {
  // Confirmed live: searching "Death Note" surfaces ~100 "Death Note dj -
  // <name>" fan-doujinshi entries. The old verification used titlesMatch(),
  // whose startsWith fallback means normTitle('Death Note dj - Light Note')
  // starts with normTitle('Death Note') and would have matched. Strict
  // normalized-title equality must reject it instead.
  global.fetch = async () => releasesPage([
    { title: 'Death Note', chapter: '105', volume: '12' },
    { title: 'Death Note dj - Light Note', chapter: '1', volume: '1' },
    { title: 'Panty Note', chapter: '3', volume: '1' },
  ]);

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(3479935384, 'Death Note');
  assert.equal(map.get('105'), '12');
  assert.equal(map.size, 1);
  assert.equal(checked, 3);
  assert.equal(verified, 1);
  assert.equal(rejected, 2);
});

test('fetchChapterVolumeMap: still accepts releases verified by numeric series id, kept as a defense-in-depth path in case the API adds that field back', async () => {
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

test('fetchChapterVolumeMap: fails closed (keeps nothing) when a record has no verifiable series field at all', async () => {
  global.fetch = async () => releasesPage([
    { chapter: '5', volume: '1' }, // no title, no series id — cannot be verified
  ]);

  const { map, checked, verified, rejected } = await fetchChapterVolumeMap(12345, 'Sakamoto Days');
  assert.equal(map.size, 0);
  assert.equal(checked, 1);
  assert.equal(verified, 0);
  assert.equal(rejected, 1);
});

test('fetchChapterVolumeMap: paginates through many on-title pages for a long-running series', async () => {
  // Confirmed live: "One Piece" title-search results stayed 100% on-title
  // through ~23 pages of 100 before degrading into word-matched noise.
  // With a real (if fuzzy) pre-filter in place, paginating deep is no
  // longer paying for an unfiltered firehose, so the cap must be high
  // enough to cover a long series' full on-title run.
  let pagesFetched = 0;
  global.fetch = async () => {
    pagesFetched++;
    const records = Array.from({ length: 100 }, (_, i) => ({
      title: 'One Piece', chapter: String(pagesFetched * 100 + i + 1), volume: String(Math.ceil((pagesFetched * 100 + i + 1) / 10)),
    }));
    return releasesPage(records);
  };

  const { map, checked, verified } = await fetchChapterVolumeMap(12345, 'One Piece');
  assert.equal(pagesFetched, 30); // hits the raised page cap since every page verifies fully
  assert.equal(checked, 3000);
  assert.equal(verified, 3000);
  assert.ok(map.size > 0);
});

test('fetchChapterVolumeMap: bails out early once pages stop verifying, instead of exhausting the full page cap', async () => {
  // Simulates the real "One Piece" pattern: on-title pages, then the fuzzy
  // search pre-filter's results degrade into unrelated title-word matches.
  let pagesFetched = 0;
  global.fetch = async () => {
    pagesFetched++;
    const onTitle = pagesFetched <= 3;
    const records = Array.from({ length: 100 }, (_, i) => ({
      title: onTitle ? 'One Piece' : 'One Hundred Storey Tower',
      chapter: String(pagesFetched * 100 + i + 1),
      volume: onTitle ? String(Math.ceil((pagesFetched * 100 + i + 1) / 10)) : '1',
    }));
    return releasesPage(records);
  };

  const start = Date.now();
  const { verified, rejected } = await fetchChapterVolumeMap(12345, 'One Piece');
  const elapsedMs = Date.now() - start;

  assert.equal(verified, 300); // only the 3 on-title pages
  assert.ok(rejected > 0);
  assert.equal(pagesFetched, 5); // 3 on-title + 2 empty pages before bail-out
  assert.ok(elapsedMs < 2000, `expected this to resolve quickly, took ${elapsedMs}ms`);
});
