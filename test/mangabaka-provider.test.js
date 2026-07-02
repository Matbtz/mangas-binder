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

test('fetchVolumeInfo: returns null rather than throwing when the API is unreachable', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  const info = await fetchVolumeInfo('One Piece');
  assert.equal(info, null);
});
