import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// AniList is a free, no-auth GraphQL cross-check for a series' total
// volume/chapter counts. Confirmed live it correctly returns null (not a
// guess) for still-publishing series, and real numbers once a work is
// finished — see fetchVolumeInfo() for the "20th Century Boys" evidence that
// motivated adding it (MangaUpdates' own count was stale; AniList's wasn't).

const { fetchVolumeInfo } = await import('../src/providers/anilist.js');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

test('fetchVolumeInfo: returns verified totals for a finished series', async () => {
  global.fetch = async () => jsonResponse({
    data: { Media: { title: { romaji: '20 Seiki Shounen', english: '20th Century Boys' }, volumes: 22, chapters: 249, status: 'FINISHED' } },
  });

  const info = await fetchVolumeInfo('20th Century Boys');
  assert.equal(info.totalVolumes, 22);
  assert.equal(info.totalChapters, 249);
  assert.equal(info.status, 'FINISHED');
});

test('fetchVolumeInfo: returns nulls (not a guess) for a still-publishing series', async () => {
  global.fetch = async () => jsonResponse({
    data: { Media: { title: { romaji: 'ONE PIECE', english: 'One Piece' }, volumes: null, chapters: null, status: 'RELEASING' } },
  });

  const info = await fetchVolumeInfo('One Piece');
  assert.equal(info.totalVolumes, null);
  assert.equal(info.totalChapters, null);
  assert.equal(info.status, 'RELEASING');
});

test('fetchVolumeInfo: fails closed when the matched title does not verify against the query', async () => {
  global.fetch = async () => jsonResponse({
    data: { Media: { title: { romaji: 'Completely Different Manga', english: null }, volumes: 5, chapters: 40, status: 'FINISHED' } },
  });

  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info, null);
});

test('fetchVolumeInfo: returns null rather than throwing when the API is unreachable', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  const info = await fetchVolumeInfo('One Piece');
  assert.equal(info, null);
});

test('fetchVolumeInfo: returns null when no media is found', async () => {
  global.fetch = async () => jsonResponse({ data: { Media: null } });
  const info = await fetchVolumeInfo('Some Unknown Series');
  assert.equal(info, null);
});
