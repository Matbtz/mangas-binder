import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// MangaBaka is a free, no-auth REST aggregator (itself pulling from
// AniList/MyAnimeList/MangaUpdates) used as a total volume/chapter
// cross-check. Confirmed live it stays populated even for ongoing series
// (unlike AniList, which only reports totals once a work is finished) — a
// live query for One Piece returned 115 volumes / 1186 chapters while it was
// still RELEASING, matching MangaUpdates' own numbers.

const { fetchVolumeInfo } = await import('../src/providers/mangabaka.js');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

test('fetchVolumeInfo: returns verified totals, including for an ongoing series', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/series/search')) {
      return jsonResponse({ data: [{ id: 123, title: 'One Piece' }] });
    }
    if (u.includes('/series/123')) {
      return jsonResponse({ data: { id: 123, title: 'One Piece', status: 'releasing', final_volume: '115', total_chapters: 1186 } });
    }
    return jsonResponse({});
  };

  const info = await fetchVolumeInfo('One Piece');
  assert.equal(info.totalVolumes, 115);
  assert.equal(info.totalChapters, 1186);
  assert.equal(info.status, 'releasing');
});

test('fetchVolumeInfo: fails closed when search returns no title-verified match', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/series/search')) {
      return jsonResponse({ data: [{ id: 999, title: 'Completely Unrelated Series' }] });
    }
    return jsonResponse({});
  };

  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info, null);
});

test('fetchVolumeInfo: returns null when the search has no results', async () => {
  global.fetch = async () => jsonResponse({ data: [] });
  const info = await fetchVolumeInfo('Some Unknown Series');
  assert.equal(info, null);
});

test('fetchVolumeInfo: surfaces an unreachable API as an error, not as "no match"', async () => {
  // A failed lookup and "MangaBaka has no such series" are different facts and
  // the consensus reports them differently, so this must NOT resolve to null —
  // a live HTTP 500 on the Bleach search was being shown as "no verified match
  // found", hiding the one provider that could have outvoted a wrong chapter
  // count. core/volume-consensus.js catches this per-provider, so a throw here
  // never breaks the wider refresh.
  global.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => fetchVolumeInfo('One Piece'), /network down/);
});

test('fetchVolumeInfo: retries a transient 5xx before giving up', async () => {
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    if (calls === 1) return new Response('boom', { status: 500 });
    if (String(url).includes('/search')) return jsonResponse({ data: [{ id: 7, title: 'One Piece' }] });
    return jsonResponse({ data: { title: 'One Piece', final_volume: 115, total_chapters: 1186, status: 'releasing' } });
  };
  const info = await fetchVolumeInfo('One Piece');
  assert.equal(info.totalVolumes, 115);
  assert.ok(calls >= 3, 'the failed search was retried');
});

test('fetchVolumeInfo: returns null when a verified match has no usable numbers', async () => {
  global.fetch = async () => jsonResponse({ data: [] });
  const info = await fetchVolumeInfo('Some Other Unknown Series');
  assert.equal(info, null);
});
