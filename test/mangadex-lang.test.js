import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

// No DB needed: we exercise the pure URL-building in listChapters/searchManga by
// stubbing global.fetch and capturing the URLs requested.
const { listChapters, searchManga } = await import('../src/providers/mangadex.js');

const realFetch = global.fetch;
const calls = [];
function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

before(() => {
  global.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes('/aggregate')) return jsonResponse({ volumes: {} });
    if (u.includes('/feed')) return jsonResponse({ data: [], total: 0 });
    if (u.includes('/manga?title=')) return jsonResponse({ data: [] });
    return jsonResponse({ data: [], total: 0 });
  };
});
after(() => { global.fetch = realFetch; });

test('listChapters requests en AND fr as fallback languages (en default, fr backup)', async () => {
  calls.length = 0;
  await listChapters('11111111-1111-1111-1111-111111111111', { lang: 'en' });
  const feed = calls.find(u => u.includes('/feed'));
  assert.ok(feed, 'made a feed request');
  assert.ok(feed.includes('translatedLanguage%5B%5D=en') || feed.includes('translatedLanguage[]=en'), 'requests English');
  assert.ok(feed.includes('translatedLanguage%5B%5D=fr') || feed.includes('translatedLanguage[]=fr'), 'requests French as backup');
});

test('listChapters for a non-en series still includes en and fr in the chain', async () => {
  calls.length = 0;
  await listChapters('22222222-2222-2222-2222-222222222222', { lang: 'ja' });
  const feed = calls.find(u => u.includes('/feed'));
  for (const l of ['ja', 'en', 'fr']) {
    assert.ok(feed.includes(`%5D=${l}`) || feed.includes(`[]=${l}`), `requests ${l}`);
  }
});

test('searchManga makes French-only series discoverable', async () => {
  calls.length = 0;
  await searchManga('quelque chose');
  const search = calls.find(u => u.includes('/manga?title='));
  assert.ok(search.includes('availableTranslatedLanguage%5B%5D=fr') || search.includes('availableTranslatedLanguage[]=fr'), 'search includes fr availability');
});
