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
const { resolveChapterVolumeMap } = await import('../src/core/chapter-map-consensus.js');
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
