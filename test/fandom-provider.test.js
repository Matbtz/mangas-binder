import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// The Fandom Wiki cross-check is unverified against live wiki markup (built
// with no network access), so every step must fail closed on anything that
// doesn't clearly verify against the series title, rather than risk feeding
// a wrong volume/chapter count into the app (same principle as the
// MangaUpdates release-verification fix).

const { fetchVolumeInfo, parseInfoboxCounts } = await import('../src/providers/fandom.js');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

test('parseInfoboxCounts: reads volume/chapter totals out of infobox-style wikitext', () => {
  const wikitext = `{{Infobox manga\n|volumes = 27\n|chapters = 265\n|status = Ongoing\n}}`;
  assert.deepEqual(parseInfoboxCounts(wikitext), { totalVolumes: 27, totalChapters: 265 });
});

test('parseInfoboxCounts: returns nulls when the fields are absent', () => {
  assert.deepEqual(parseInfoboxCounts('{{Infobox manga|status=Ongoing}}'), { totalVolumes: null, totalChapters: null });
  assert.deepEqual(parseInfoboxCounts(null), { totalVolumes: null, totalChapters: null });
});

test('fetchVolumeInfo: verifies the resolved wiki against the series title before trusting it', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('www.fandom.com/api/v1/Search/List')) {
      return jsonResponse({ items: [{ domain: 'sakamotodays.fandom.com', title: 'Sakamoto Days Wiki' }] });
    }
    if (u.includes('sakamotodays.fandom.com/api.php') && u.includes('list=search')) {
      return jsonResponse({ query: { search: [{ title: 'Sakamoto Days' }] } });
    }
    if (u.includes('sakamotodays.fandom.com/api.php') && u.includes('action=parse')) {
      return jsonResponse({ parse: { wikitext: { '*': '{{Infobox manga|volumes=17|chapters=180}}' } } });
    }
    return jsonResponse({});
  };

  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info.totalVolumes, 17);
  assert.equal(info.totalChapters, 180);
  assert.ok(info.wikiUrl.includes('sakamotodays.fandom.com'));
});

test('fetchVolumeInfo: fails closed when the wiki search returns an unrelated title', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('www.fandom.com/api/v1/Search/List')) {
      // Cross-wiki search returns something completely unrelated to the query.
      return jsonResponse({ items: [{ domain: 'unrelated.fandom.com', title: 'Some Other Wiki' }] });
    }
    if (u.includes('unrelated.fandom.com/api.php') && u.includes('list=search')) {
      return jsonResponse({ query: { search: [{ title: 'Completely Different Series' }] } });
    }
    return jsonResponse({});
  };

  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info, null);
});

test('fetchVolumeInfo: returns null rather than throwing when the API is unreachable', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info, null);
});
