import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-chmap-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded, setProviderEnabled } = await import('../src/core/settings.js');
const {
  resolveChapterVolumeMap, fetchExternalChapterSources,
  serializeExternalCache, readCachedExternal, getVolumeTitle,
} = await import('../src/core/chapter-map-consensus.js');
const { provider: wikipedia } = await import('../src/providers/wikipedia.js');
const { provider: fandom } = await import('../src/providers/fandom.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const realWiki = wikipedia.fetchChapterVolumeMap;
const realFandom = fandom.fetchChapterVolumeMap;
beforeEach(() => { wikipedia.fetchChapterVolumeMap = realWiki; fandom.fetchChapterVolumeMap = realFandom; });
after(() => { wikipedia.fetchChapterVolumeMap = realWiki; fandom.fetchChapterVolumeMap = realFandom; });

const chapters = [
  { number: '5', volume: '1' },   // mangadex tag
  { number: '6', volume: null },  // untagged
  { number: '7', volume: '2' },   // mangadex tag
];

test('priority: wikipedia overrides fandom overrides mangadex tags', async () => {
  setProviderEnabled('wikipedia', true);
  setProviderEnabled('fandom', true);
  // Wikipedia covers ch5 (says vol 2, disagreeing with MangaDex's vol 1);
  // Fandom covers ch6 (vol 2). Both maps are internally plausible (monotonic).
  wikipedia.fetchChapterVolumeMap = async () => ({ map: new Map([['5', '2']]), volumeTitles: new Map([['2', 'Vol Two']]) });
  fandom.fetchChapterVolumeMap = async () => ({ map: new Map([['6', '2']]), volumeTitles: new Map() });

  const { map, counts, volumeTitles } = await resolveChapterVolumeMap('X', chapters, { totalVolumesHint: 10 });
  assert.equal(map.get('5').volume, '2');        // wikipedia wins over mangadex(1)
  assert.equal(map.get('5').source, 'wikipedia');
  assert.equal(map.get('6').volume, '2');        // fandom fills an untagged chapter
  assert.equal(map.get('6').source, 'fandom');
  assert.equal(map.get('7').volume, '2');        // untouched mangadex tag
  assert.equal(map.get('7').source, 'mangadex');
  assert.equal(counts.wikipedia, 1);
  assert.equal(counts.fandom, 1);
  assert.equal(volumeTitles.get('2'), 'Vol Two');
});

test('a source whose volume numbers are physically impossible for the chapter count is rejected wholesale', async () => {
  setProviderEnabled('wikipedia', true);
  setProviderEnabled('fandom', false);
  // "chapter 6 → volume 40" implies <1 chapter/volume — a mis-parse; must not win.
  wikipedia.fetchChapterVolumeMap = async () => ({ map: new Map([['6', '40']]), volumeTitles: new Map() });

  const { map } = await resolveChapterVolumeMap('X', chapters, { totalVolumesHint: 10 });
  assert.equal(map.get('6'), undefined);          // implausible wiki map dropped; ch6 stays untagged
  assert.equal(map.get('5').source, 'mangadex');  // baseline preserved
});

test('with the wiki sources disabled, result is just the MangaDex tags (no regression)', async () => {
  setProviderEnabled('wikipedia', false);
  setProviderEnabled('fandom', false);
  const { map, counts } = await resolveChapterVolumeMap('X', chapters, { totalVolumesHint: 10 });
  assert.equal(map.get('5').source, 'mangadex');
  assert.equal(map.get('7').source, 'mangadex');
  assert.equal(map.get('6'), undefined);
  assert.equal(counts.mangadex, 2);
  assert.ok(!counts.wikipedia && !counts.fandom);
});

// --- Cache: fetchExternalChapterSources / serialize / readCachedExternal / getVolumeTitle ---

test('fetchExternalChapterSources returns just the external (non-MangaDex) map — the cacheable piece', async () => {
  setProviderEnabled('wikipedia', true);
  setProviderEnabled('fandom', false);
  wikipedia.fetchChapterVolumeMap = async () => ({ map: new Map([['5', '2']]), volumeTitles: new Map([['2', 'Vol Two']]) });

  const external = await fetchExternalChapterSources('X', { totalVolumesHint: 10, chapterCount: 3 });
  assert.equal(external.map.get('5').volume, '2');
  assert.equal(external.map.get('5').source, 'wikipedia');
  assert.equal(external.volumeTitles.get('2'), 'Vol Two');
  assert.ok(external.reports.some(r => r.name === 'Wikipedia' && r.mapped === 1));
});

test('resolveChapterVolumeMap with a cachedExternal skips the network entirely and overlays it on a fresh MangaDex baseline', async () => {
  setProviderEnabled('wikipedia', true);
  let wikiCalled = false;
  wikipedia.fetchChapterVolumeMap = async () => { wikiCalled = true; return { map: new Map([['5', '9']]), volumeTitles: new Map() }; };

  const cachedExternal = { map: new Map([['5', { volume: '3', source: 'wikipedia' }]]), volumeTitles: new Map([['3', 'Cached Title']]), reports: [{ name: 'Wikipedia', role: 'per-chapter volume list', mapped: 1 }] };
  const result = await resolveChapterVolumeMap('X', chapters, { totalVolumesHint: 10, cachedExternal });

  assert.equal(wikiCalled, false, 'no network call made when a cachedExternal is supplied');
  assert.equal(result.externalFromCache, true);
  assert.equal(result.map.get('5').volume, '3'); // from the cache, not a live "9"
  assert.equal(result.map.get('7').source, 'mangadex'); // fresh MangaDex baseline still applied
  assert.equal(result.volumeTitles.get('3'), 'Cached Title');
});

test('resolveChapterVolumeMap without a cachedExternal fetches fresh and reports externalFromCache=false', async () => {
  setProviderEnabled('wikipedia', true);
  wikipedia.fetchChapterVolumeMap = async () => ({ map: new Map([['5', '2']]), volumeTitles: new Map() });
  const result = await resolveChapterVolumeMap('X', chapters, { totalVolumesHint: 10 });
  assert.equal(result.externalFromCache, false);
  assert.equal(result.map.get('5').volume, '2');
});

test('serializeExternalCache + readCachedExternal round-trip, honouring the TTL', async () => {
  const external = { map: new Map([['5', { volume: '2', source: 'wikipedia' }]]), volumeTitles: new Map([['2', 'Vol Two']]), reports: [] };
  const payload = serializeExternalCache(external);
  assert.equal(typeof payload.fetchedAt, 'number');

  const fakeSeries = { chapter_map_cache_json: JSON.stringify(payload) };
  const fresh = readCachedExternal(fakeSeries, 24 * 3600000);
  assert.ok(fresh, 'fresh cache is read back');
  assert.equal(fresh.map.get('5').volume, '2');
  assert.equal(fresh.volumeTitles.get('2'), 'Vol Two');

  const stale = readCachedExternal(fakeSeries, 0); // TTL of 0ms => everything is stale
  assert.equal(stale, null, 'past-TTL cache is treated as absent');
});

test('readCachedExternal fails closed on missing/corrupt cache data', () => {
  assert.equal(readCachedExternal(null, 1000), null);
  assert.equal(readCachedExternal({}, 1000), null);
  assert.equal(readCachedExternal({ chapter_map_cache_json: 'not json' }, 1000), null);
  assert.equal(readCachedExternal({ chapter_map_cache_json: '{"no_fetchedAt":true}' }, 1000), null);
});

test('getVolumeTitle reads a title out of the cache regardless of TTL (best-effort, not correctness-critical)', () => {
  const payload = { fetchedAt: Date.now() - 999 * 24 * 3600000, volumeTitles: [['1', 'Romance Dawn']], map: [], reports: [] };
  const fakeSeries = { chapter_map_cache_json: JSON.stringify(payload) };
  assert.equal(getVolumeTitle(fakeSeries, '1'), 'Romance Dawn');
  assert.equal(getVolumeTitle(fakeSeries, '2'), ''); // no title for volume 2
  assert.equal(getVolumeTitle(null, '1'), '');
  assert.equal(getVolumeTitle({ chapter_map_cache_json: 'garbage' }, '1'), '');
});
