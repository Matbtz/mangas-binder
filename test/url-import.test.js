import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB/paths before any module reads config.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-urlimport-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { detectProviderFromUrl, getProvider, metadataProviders, allProviders } = await import('../src/providers/index.js');
const { closeDb } = await import('../src/core/db.js');

after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

test('detectProviderFromUrl: recognizes a MangaDex title URL', () => {
  const r = detectProviderFromUrl('https://mangadex.org/title/a1b2c3d4-e5f6-7890-abcd-ef1234567890/some-slug');
  assert.deepEqual(r, { provider: 'mangadex', providerSeriesId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
});

test('detectProviderFromUrl: recognizes a MangaKatana series URL', () => {
  const url = 'https://mangakatana.com/manga/some-series.12345';
  const r = detectProviderFromUrl(url);
  assert.deepEqual(r, { provider: 'mangakatana', providerSeriesId: url });
});

test('detectProviderFromUrl: recognizes a ComicVine volume URL', () => {
  const r = detectProviderFromUrl('https://comicvine.gamespot.com/saga/volume/4050-12345/');
  assert.deepEqual(r, { provider: 'comicvine', providerSeriesId: '12345' });
});

test('detectProviderFromUrl: returns null for an unrecognized URL', () => {
  assert.equal(detectProviderFromUrl('https://example.com/whatever'), null);
});

test('detectProviderFromUrl: returns null for a non-URL', () => {
  assert.equal(detectProviderFromUrl('One Piece'), null);
  assert.equal(detectProviderFromUrl(''), null);
});

test('mangaupdates has no getSeries, so it must not be offered as a followable metadata source', () => {
  const mu = getProvider('mangaupdates');
  assert.equal(typeof mu.getSeries, 'undefined');
  assert.equal(mu.capabilities.metadata, false);
  assert.ok(!metadataProviders().some(p => p.name === 'mangaupdates'));
});

test('every metadata-capable provider exposes search() — /api/search and the Add tab call it by that name', () => {
  for (const p of allProviders()) {
    if (!p.capabilities.metadata) continue;
    assert.equal(typeof p.search, 'function', `${p.name}.search must be a function`);
  }
});

test('mangakatana.search is wired up (regression: it only exposed searchSeries, not search)', () => {
  const mk = getProvider('mangakatana');
  // search() is the base.js interface name the Add tab / /api/search call. It
  // returns the standard { id, title } shape (see mangakatana.test.js) so the
  // Follow button's providerSeriesId is populated — unlike the raw searchSeries()
  // crawl (which yields { url, title }). searchSeries() is kept too because
  // download/fallback.js imports it directly.
  assert.equal(typeof mk.search, 'function', 'search() must be wired up');
  assert.equal(typeof mk.searchSeries, 'function', 'searchSeries() kept for the fallback path');
});
