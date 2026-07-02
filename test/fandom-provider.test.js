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

// --- Regressions from the live investigation that fixed this provider ---
// (it previously returned null for every series: www.fandom.com's cross-wiki
// search sits behind a Cloudflare bot challenge and 403s plain server-side
// requests — confirmed live — so findWiki() needed a fallback that doesn't
// depend on it, and page selection needed to try more than the first
// title-matching search hit.)

test('fetchVolumeInfo: falls back to guessing the wiki subdomain when the cross-wiki search is unreachable/blocked', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('www.fandom.com/api/v1/Search/List')) {
      return { ok: false, status: 403, json: async () => ({}) }; // Cloudflare challenge, as observed live
    }
    // "Sakamoto Days" -> concatenated slug fails, hyphenated slug succeeds
    // (mirrors the real subdomain, confirmed live).
    if (u.includes('sakamotodays.fandom.com/api.php') && u.includes('meta=siteinfo')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.includes('sakamoto-days.fandom.com/api.php') && u.includes('meta=siteinfo')) {
      return jsonResponse({ query: { general: { sitename: 'Sakamoto Days Wiki' } } });
    }
    if (u.includes('sakamoto-days.fandom.com/api.php') && u.includes('action=parse')) {
      return jsonResponse({ parse: { wikitext: { '*': '{{Infobox manga|volumes=27|chapters=265}}' } } });
    }
    return jsonResponse({});
  };

  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info.totalVolumes, 27);
  assert.ok(info.wikiUrl.includes('sakamoto-days.fandom.com'));
});

test('fetchVolumeInfo: slug-guess fallback fails closed when no candidate siteinfo verifies against the title', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('www.fandom.com/api/v1/Search/List')) return { ok: false, status: 403, json: async () => ({}) };
    if (u.includes('.fandom.com/api.php') && u.includes('meta=siteinfo')) {
      return jsonResponse({ query: { general: { sitename: 'Some Unrelated Wiki' } } });
    }
    return jsonResponse({});
  };

  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info, null);
});

test('fetchVolumeInfo: tries the "(Manga)" disambiguated title directly before falling back to fuzzy search', async () => {
  // Reproduces the real Sakamoto Days wiki: the literal-title page is a
  // near-empty landing page with no infobox, while "Sakamoto Days (Manga)"
  // has the real data. Direct titles must be tried before trusting fuzzy
  // search, which ranks the landing page first.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('www.fandom.com/api/v1/Search/List')) {
      return jsonResponse({ items: [{ domain: 'sakamoto-days.fandom.com', title: 'Sakamoto Days Wiki' }] });
    }
    if (u.includes('action=parse') && u.includes('page=Sakamoto%20Days&')) {
      return jsonResponse({ parse: { wikitext: { '*': 'A near-empty landing page with no infobox.' } } });
    }
    if (u.includes('action=parse') && u.includes('page=Sakamoto%20Days%20(Manga)')) {
      return jsonResponse({ parse: { wikitext: { '*': '{{Infobox manga|volumes=27+}}' } } });
    }
    return jsonResponse({});
  };

  const info = await fetchVolumeInfo('Sakamoto Days');
  assert.equal(info.totalVolumes, 27);
  assert.equal(info.pageTitle, 'Sakamoto Days (Manga)');
});

test('parseInfoboxCounts: falls back to lead-section prose counts for stub articles without a populated infobox', () => {
  // Real text from the "20th Century Boys" Fandom wiki's stub article.
  const wikitext = `{{Stub}}\n'''20th Century Boys''' is a manga. The manga counts a total of 249 chapters initially published in 22 tankōbon volumes by Shogakukan.`;
  assert.deepEqual(parseInfoboxCounts(wikitext), { totalVolumes: 22, totalChapters: 249 });
});

test('parseInfoboxCounts: prose fallback ignores approximate language ("over 1000 chapters") rather than treating it as exact', () => {
  const wikitext = `''One Piece'' has currently published over 1000 chapters (collected into over 100 tankōbon volumes).`;
  assert.deepEqual(parseInfoboxCounts(wikitext), { totalVolumes: null, totalChapters: null });
});

test('parseInfoboxCounts: prose fallback does not match a number mentioned deep in the article body', () => {
  const lead = 'A'.repeat(2100); // push the real mention past the lead-section window
  const wikitext = `${lead} total of 999 chapters in 999 volumes`;
  assert.deepEqual(parseInfoboxCounts(wikitext), { totalVolumes: null, totalChapters: null });
});
