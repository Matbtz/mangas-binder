import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

// Exercises the volume-tag reconciliation in listChapters: MangaDex volume tags
// are set per scanlation group, so one group's bad tag must not win just because
// it happened to sort first (e.g. more pages, or first in feed order).
const { listChapters } = await import('../src/providers/mangadex.js');

const realFetch = global.fetch;
function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

function chapterEntry(id, { chapter, volume, pages, lang = 'en' }) {
  return {
    id,
    attributes: {
      chapter,
      volume,
      pages,
      translatedLanguage: lang,
      title: '',
      publishAt: null,
    },
  };
}

after(() => { global.fetch = realFetch; });

test('listChapters: majority vote wins over a single mistagged group, even if it sorts first', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/aggregate')) return jsonResponse({ volumes: {} });
    if (u.includes('/feed')) {
      return jsonResponse({
        total: 3,
        data: [
          // This group's tag ("5") would win under the old "first candidate wins its
          // own tag verbatim" logic (it's the first entry with the most pages), but
          // two other groups agree on "2" — majority vote should side with them.
          chapterEntry('bad-group', { chapter: '10', volume: '5', pages: 12 }),
          chapterEntry('good-group-a', { chapter: '10', volume: '2', pages: 10 }),
          chapterEntry('good-group-b', { chapter: '10', volume: '2', pages: 8 }),
        ],
      });
    }
    return jsonResponse({ data: [], total: 0 });
  };

  const chapters = await listChapters('33333333-3333-3333-3333-333333333333', { lang: 'en' });
  const ch10 = chapters.find(c => c.number === '10');
  assert.ok(ch10, 'chapter 10 present');
  assert.equal(ch10.volume, '2');
});

test('listChapters: falls back to the winning candidate\'s own tag when there is no majority', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/aggregate')) return jsonResponse({ volumes: {} });
    if (u.includes('/feed')) {
      return jsonResponse({
        total: 1,
        data: [chapterEntry('only-group', { chapter: '11', volume: '3', pages: 10 })],
      });
    }
    return jsonResponse({ data: [], total: 0 });
  };

  const chapters = await listChapters('44444444-4444-4444-4444-444444444444', { lang: 'en' });
  const ch11 = chapters.find(c => c.number === '11');
  assert.equal(ch11.volume, '3');
});

test('listChapters: ties break in favor of the curated aggregate TOC', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/aggregate')) {
      return jsonResponse({ volumes: { '4': { volume: '4', chapters: { '12': { chapter: '12' } } } } });
    }
    if (u.includes('/feed')) {
      return jsonResponse({
        total: 1,
        data: [chapterEntry('lone-group', { chapter: '12', volume: '7', pages: 10 })],
      });
    }
    return jsonResponse({ data: [], total: 0 });
  };

  const chapters = await listChapters('55555555-5555-5555-5555-555555555555', { lang: 'en' });
  const ch12 = chapters.find(c => c.number === '12');
  // aggregate vote (weight 2) beats the single group's vote (weight 1).
  assert.equal(ch12.volume, '4');
});
