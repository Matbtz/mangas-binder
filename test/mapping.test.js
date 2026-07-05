import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB/paths before any module reads config.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-map-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState, getSeries } = await import('../src/core/repo.js');
const { resolveVolumes } = await import('../src/core/mapping.js');
const { extrapolateVolumes, sanitizeVolumeMap, getVolumeStats } = await import('../src/core/extrapolate.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const numbers = c => c.map(x => x.number);

test('extrapolate: no hint groups untagged chapters by avg chapters/volume', () => {
  const volumeMap = { '1': ['1', '2', '3'], '2': ['4', '5', '6'] };
  const { calculated, overflow } = extrapolateVolumes(volumeMap, ['7', '8', '9', '10', '11', '12']);
  assert.deepEqual(calculated, { '3': ['7', '8', '9'], '4': ['10', '11', '12'] });
  assert.deepEqual(overflow, []);
});

test('extrapolate: hint caps volumes and overflows the rest', () => {
  // Pin chsPerVol explicitly so this isolates the cap/overflow mechanism from
  // the (separate) auto chsPerVol/hint blending covered below.
  const volumeMap = { '1': ['1', '2', '3'], '2': ['4', '5', '6'] };
  const { calculated, overflow } = extrapolateVolumes(volumeMap, ['7', '8', '9', '10', '11', '12'], 3, true, 3);
  assert.deepEqual(calculated, { '3': ['7', '8', '9'] });
  assert.deepEqual(overflow, ['10', '11', '12']);
});

test('extrapolate: with no explicit chsPerVol, the total-volume hint reshapes the tail so the last estimated volume matches the known total', () => {
  // MangaDex only tagged the first 3 volumes (7 chapters each); MangaUpdates
  // says the series has 20 volumes total, and there are 200 more untagged
  // chapters. The historical average (7/volume) would blow past volume 20
  // (landing around volume 32); blending in the hint should instead spread
  // the remaining chapters so the last one lands on volume 20.
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  const volumeMap = { '1': range(1, 7), '2': range(8, 14), '3': range(15, 21) };
  const { calculated, overflow } = extrapolateVolumes(volumeMap, range(22, 221), 20, false, null);
  assert.deepEqual(overflow, []);
  const volNums = Object.keys(calculated).filter(v => v !== 'Specials').map(Number);
  assert.equal(Math.max(...volNums), 20);
});

test('extrapolate: no anchors + volume & chapter hints spread chapters evenly across exactly that many volumes (the "Pet" case)', () => {
  // Pet: a finished 5-volume / 55-chapter series whose scanlation source tags
  // no volumes at all. The old code fell back to ceil(chapter/10) with no cap,
  // inventing phantom volumes well past 5; it must now land exactly 5 even
  // volumes of ~11 chapters each.
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  const { calculated, overflow } = extrapolateVolumes({}, range(1, 55), 5, false, null, 55);
  assert.deepEqual(overflow, []);
  const volNums = Object.keys(calculated).filter(v => v !== 'Specials').map(Number).sort((a, b) => a - b);
  assert.deepEqual(volNums, [1, 2, 3, 4, 5]);
  const counts = volNums.map(v => calculated[String(v)].length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `expected even split, got ${counts}`);
  assert.deepEqual(calculated['1'], range(1, 11));
  assert.deepEqual(calculated['5'], range(45, 55));
});

test('extrapolate: no anchors + volume hint but no chapter total falls back to rank-based even split (immune to number gaps)', () => {
  // Sparse/noisy chapter numbering (a stray "chapter 60") must not blow the
  // split apart: distributing by rank keeps it even and bounded at the hint.
  const { calculated, overflow } = extrapolateVolumes({}, ['1', '2', '5', '7', '60', '61', '62'], 3, false, null, null);
  assert.deepEqual(overflow, []);
  const volNums = Object.keys(calculated).filter(v => v !== 'Specials').map(Number).sort((a, b) => a - b);
  assert.deepEqual(volNums, [1, 2, 3]); // exactly 3, gapless
  const counts = volNums.map(v => calculated[String(v)].length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `expected even split, got ${counts}`);
});

test('extrapolate: stray out-of-range chapters clamp into the final known volume instead of minting phantom volumes', () => {
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  const { calculated } = extrapolateVolumes({}, [...range(1, 10), '1190'], 2, false, null, 10);
  const volNums = Object.keys(calculated).filter(v => v !== 'Specials').map(Number);
  assert.equal(Math.max(...volNums), 2); // never a volume 119
  assert.ok(calculated['2'].includes('1190'));
});

test('resolveVolumes: assigns estimated volumes to untagged chapters, keeps real tags', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'map1', title: 'Map One', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  for (const n of ['4', '5', '6', '7', '8', '9']) upsertChapter(s.id, { provider: 'mangadex', number: n }); // untagged

  const { assigned } = resolveVolumes(s.id);
  assert.equal(assigned, 6);

  const chs = listChaptersForSeries(s.id);
  const vol = n => chs.find(c => c.number === n);
  // real tags untouched
  assert.equal(vol('1').volume, '1');
  assert.equal(vol('1').calculated, 0);
  // estimated: 3 per volume → vol2 = 4,5,6 ; vol3 = 7,8,9
  assert.equal(vol('4').volume, '2'); assert.equal(vol('4').calculated, 1);
  assert.equal(vol('6').volume, '2');
  assert.equal(vol('7').volume, '3');
  assert.equal(vol('9').volume, '3');
});

test('resolveVolumes: an untagged, finished series is bounded by its persisted volume/chapter hints', () => {
  // End-to-end version of the "Pet" fix: no chapter carries a real volume tag,
  // but the series knows it is 5 volumes / 55 chapters. Estimation must fill
  // exactly volumes 1-5, never a phantom high volume.
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'petmap', title: 'Pet Map', language: 'en',
    monitored: true, packagingMode: 'volume', totalVolumesHint: 5, totalChaptersHint: 55,
  });
  const stored = getSeries(s.id);
  assert.equal(stored.total_chapters_hint, 55); // column persisted
  for (let i = 1; i <= 55; i++) upsertChapter(s.id, { provider: 'mangadex', number: String(i) }); // all untagged

  resolveVolumes(s.id);
  const chs = listChaptersForSeries(s.id);
  const vols = [...new Set(chs.map(c => parseFloat(c.volume)))].filter(v => !Number.isNaN(v)).sort((a, b) => a - b);
  assert.deepEqual(vols, [1, 2, 3, 4, 5]);
  assert.ok(chs.every(c => c.calculated === 1));
});

test('sanitizeVolumeMap: demotes poison volume tags numbered past the total-volume hint (the "Pet" case)', () => {
  // The reported "Pet" breakdown: a finished 5-volume series whose DB was
  // polluted with scattered single-chapter tags at volumes 7, 8, ... 89 (a
  // since-fixed cross-series MangaUpdates override). Each is individually small
  // and in order, so passes 1-3 never reject them — only the total-volume cap
  // does. Without a hint they must stay untouched (backwards compatible).
  const volumeMap = {
    '1': ['1', '2', '3', '4', '5'],
    '7': ['46', '47'], '8': ['48'], '10': ['49', '50'], '89': ['55'],
  };
  const noHint = sanitizeVolumeMap(volumeMap);
  assert.ok('89' in noHint.cleanVolumeMap, 'without a hint, over-cap tags are left alone');

  const { cleanVolumeMap, noisy } = sanitizeVolumeMap(volumeMap, { totalVolumesHint: 5 });
  for (const v of ['7', '8', '10', '89']) {
    assert.equal(v in cleanVolumeMap, false, `poison volume ${v} should be demoted`);
  }
  assert.deepEqual(cleanVolumeMap['1'], ['1', '2', '3', '4', '5'], 'in-bound volume 1 survives');
  assert.deepEqual(noisy.sort((a, b) => Number(a) - Number(b)), ['46', '47', '48', '49', '50', '55']);
});

test('extrapolateVolumes: poison anchors past the hint are re-estimated back inside [1..hint]', () => {
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  // Chapters 1-44 untagged; 45-55 carry garbage volume tags well past the real
  // 5-volume total. Every chapter must land in volumes 1-5, none beyond.
  const volumeMap = { '7': ['45', '46'], '9': ['47'], '20': ['48', '49'], '61': range(50, 53), '89': ['54', '55'] };
  const { calculated, overflow } = extrapolateVolumes(volumeMap, range(1, 44), 5, false, null, 55);
  assert.deepEqual(overflow, []);
  const volNums = Object.keys(calculated).filter(v => v !== 'Specials').map(Number).sort((a, b) => a - b);
  assert.equal(Math.max(...volNums), 5, `no volume beyond the 5-volume hint, got ${volNums}`);
  assert.equal(Object.values(calculated).reduce((a, chs) => a + chs.length, 0), 55, 'every chapter placed');
});

test('getVolumeStats: a too-thin tagged sample falls back to the consensus chapters/volume ratio (the "Fool Night" case)', () => {
  // Fool Night: the primary provider tagged only volumes 0, 1, 2 with a single
  // chapter each — a sampled average of 1. Against a 12-volume / 109-chapter
  // consensus the honest estimate is ~9 chapters/volume, not 1.
  const volumeMap = { '0': ['0'], '1': ['1'], '2': ['2'] };
  const bare = getVolumeStats(volumeMap);
  assert.ok(bare.avgChsPerVol <= 3, 'with no consensus the thin sample is all we have');
  const stats = getVolumeStats(volumeMap, { totalVolumesHint: 12, totalChaptersHint: 109 });
  assert.equal(stats.avgChsPerVol, 9, `expected round(109/12)=9, got ${stats.avgChsPerVol}`);
});

test('resolveVolumes: a fully-tagged but poison-polluted series self-heals to within its volume hint', () => {
  // End-to-end "Pet": every chapter already carries a volume tag (so nothing is
  // "unassigned"), but many are impossible garbage (volumes 7-89 on a 5-volume
  // series). The refresh path must still detect and correct them.
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'poison', title: 'Poison Series', language: 'en',
    monitored: true, packagingMode: 'volume', totalVolumesHint: 5, totalChaptersHint: 55,
  });
  for (let i = 1; i <= 44; i++) upsertChapter(s.id, { provider: 'mangadex', number: String(i), volume: '1' });
  const poison = { 45: '7', 46: '8', 47: '9', 48: '20', 49: '61', 50: '61', 51: '61', 52: '63', 53: '63', 54: '89', 55: '89' };
  for (const [n, v] of Object.entries(poison)) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: v });

  const { assigned } = resolveVolumes(s.id);
  assert.ok(assigned > 0, 'poison tags trigger a re-estimation even with nothing unassigned');

  const chs = listChaptersForSeries(s.id);
  const vols = chs.map(c => parseFloat(c.volume)).filter(v => !Number.isNaN(v));
  assert.equal(Math.max(...vols), 5, `no chapter should keep a volume past the 5-volume hint, got ${Math.max(...vols)}`);
});

test('sanitizeVolumeMap: rejects a mistagged outlier that would overlap the next volume', () => {
  // Mirrors a real MangaDex bug report: volume mins step cleanly by ~9, but one
  // rogue chapter per volume balloons the max far past the next volume's start.
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  const volumeMap = {
    '1': range(1, 7),
    '2': [...range(8, 16), '54'],
    '3': [...range(17, 25), '69'],
    '4': range(26, 34),
  };
  const { cleanVolumeMap, noisy } = sanitizeVolumeMap(volumeMap);
  assert.deepEqual(noisy.sort(), ['54', '69']);
  assert.deepEqual(cleanVolumeMap['2'], range(8, 16));
  assert.deepEqual(cleanVolumeMap['3'], range(17, 25));
  // Ranges are now monotonic and non-overlapping.
  const maxOf = v => Math.max(...cleanVolumeMap[v].map(Number));
  const minOf = v => Math.min(...cleanVolumeMap[v].map(Number));
  assert.ok(maxOf('2') < minOf('3'));
  assert.ok(maxOf('3') < minOf('4'));
});

test('sanitizeVolumeMap: demotes whole volumes whose size is a severe outlier vs. the series median', () => {
  // Mirrors a real One Piece production case: a clean run of ~11 chapters/
  // volume everywhere, except a handful of volumes a scanlation/digital-omnibus
  // group tagged with 33 chapters each — internally consistent (no per-chapter
  // deviation, no overlap with neighbors), so passes 1 and 2 never see anything
  // to reject. Only the whole-volume size check catches this.
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  const volumeMap = {};
  let ch = 1;
  for (let v = 1; v <= 10; v++) { volumeMap[String(v)] = range(ch, ch + 10); ch += 11; }
  for (let v = 28; v <= 32; v++) { volumeMap[String(v)] = range(ch, ch + 32); ch += 33; }
  for (let v = 33; v <= 37; v++) { volumeMap[String(v)] = range(ch, ch + 10); ch += 11; }

  const { cleanVolumeMap, noisy } = sanitizeVolumeMap(volumeMap);
  for (let v = 28; v <= 32; v++) assert.equal(String(v) in cleanVolumeMap, false, `vol ${v} should have been demoted`);
  assert.equal(noisy.length, 5 * 33);
  // Untouched: the clean runs on either side are unaffected.
  assert.equal(cleanVolumeMap['5'].length, 11);
  assert.equal(cleanVolumeMap['35'].length, 11);
});

test('extrapolateVolumes: an oversized real block gets redistributed across a wider span once demoted, instead of staying a single 30+ chapter volume', () => {
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  const volumeMap = {};
  let ch = 1;
  for (let v = 1; v <= 10; v++) { volumeMap[String(v)] = range(ch, ch + 10); ch += 11; }
  const gapStart = ch;
  ch += 17 * 11; // volumes 11-27 exist as chapters but were never tagged at all
  for (let v = 28; v <= 32; v++) { volumeMap[String(v)] = range(ch, ch + 32); ch += 33; }
  for (let v = 33; v <= 37; v++) { volumeMap[String(v)] = range(ch, ch + 10); ch += 11; }
  const unassigned = range(gapStart, gapStart + 17 * 11 - 1);

  const { calculated, overflow } = extrapolateVolumes(volumeMap, unassigned, null, false, null);
  assert.deepEqual(overflow, []);
  const allCounts = Object.values(calculated).map(chs => chs.length);
  // Before the whole-volume demotion fix, volumes 28-32 stayed trusted anchors
  // at 33 chapters each; now they're folded back into estimation and spread
  // across the wider 11-32 span instead of remaining a single 33-chapter block.
  assert.ok(Math.max(...allCounts) < 33, `expected no single volume to keep all 33 chapters, got ${Math.max(...allCounts)}`);
});

test('resolveVolumes: demotes a noisy "real" tag even when no chapter is unassigned', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'map3', title: 'Map Three', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  for (const n of ['4', '5', '6']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '2' });
  // Chapter 50 is mistagged into volume 2 by MangaDex — every chapter has a
  // volume already, so nothing is "unassigned", yet this tag is still bogus.
  upsertChapter(s.id, { provider: 'mangadex', number: '50', volume: '2' });
  for (const n of ['7', '8', '9']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '3' });

  const { assigned } = resolveVolumes(s.id);
  assert.ok(assigned >= 1);

  const chs = listChaptersForSeries(s.id);
  const ch50 = chs.find(c => c.number === '50');
  assert.notEqual(ch50.volume, '2');
  assert.equal(ch50.calculated, 1);
});

test('extrapolateVolumes: sparse anchors spread the gap evenly instead of piling into the volume before the next anchor', () => {
  // Only volume 1 (chapters 1-7) and volume 10 (chapters 100-102) are tagged;
  // chapters 8-99 are untagged. Walking forward with a flat 7-chapters/volume
  // rate and clamping at volume 10 used to dump everything that didn't fit
  // into volume 9 alone (43 chapters). It should now spread evenly across the
  // 8 available slots (volumes 2-9).
  const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
  const volumeMap = { '1': range(1, 7), '10': ['100', '101', '102'] };
  const { calculated, overflow } = extrapolateVolumes(volumeMap, range(8, 99), null, false, 7);
  assert.deepEqual(overflow, []);
  const counts = Object.entries(calculated)
    .filter(([v]) => v !== 'Specials')
    .map(([, chs]) => chs.length);
  assert.equal(counts.reduce((a, b) => a + b, 0), 92);
  // No single volume should absorb an outsized share of the gap.
  assert.ok(Math.max(...counts) <= 12, `expected an even split, got a max of ${Math.max(...counts)}`);
});

test('getVolumeStats: a single oversized volume does not drag the average up (median, not mean)', () => {
  const volumeMap = {
    '1': ['1', '2', '3', '4', '5', '6', '7'],
    '2': ['8', '9', '10', '11', '12', '13', '14'],
    '3': ['15', '16', '17', '18', '19', '20', '21'],
    '4': ['22', '23', '24', '25', '26', '27', '28'],
    '5': Array.from({ length: 30 }, (_, i) => String(29 + i)), // one abnormally large volume
    '6': ['59', '60', '61', '62', '63', '64', '65'],
    '7': ['66', '67', '68', '69', '70', '71', '72'],
    '8': ['73', '74', '75', '76', '77', '78', '79'],
    '9': ['80', '81', '82', '83', '84', '85', '86'],
  };
  const stats = getVolumeStats(volumeMap);
  // The mean would be dragged to 10; the median of the per-volume counts is 7.
  assert.equal(stats.avgChsPerVol, 7);
});

test('extrapolateVolumes: chapters beyond the last real volume are grouped into new sequential volumes (unreleased content)', () => {
  const volumeMap = { '1': ['1', '2', '3'], '2': ['4', '5', '6'], '3': ['7', '8', '9'] };
  // Nothing tags volume 4 yet — these are the not-yet-released chapters.
  const { calculated, overflow } = extrapolateVolumes(volumeMap, ['10', '11', '12', '13', '14', '15']);
  assert.deepEqual(calculated, { '4': ['10', '11', '12'], '5': ['13', '14', '15'] });
  assert.deepEqual(overflow, []);
});

test('resolveVolumes: never reassigns already-imported chapters', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'map2', title: 'Map Two', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  for (const n of ['4', '5', '6']) upsertChapter(s.id, { provider: 'mangadex', number: n });
  // pretend ch4 was already imported into some volume
  const ch4 = listChaptersForSeries(s.id).find(c => c.number === '4');
  setChapterState(ch4.id, 'imported', { volume: '99', calculated: 1 });

  resolveVolumes(s.id);
  const after = listChaptersForSeries(s.id).find(c => c.number === '4');
  assert.equal(after.volume, '99'); // unchanged
  assert.equal(after.state, 'imported');
});

test('resolveVolumes: never reassigns chapters already packaged into "bindery"', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'map4', title: 'Map Four', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  for (const n of ['4', '5', '6']) upsertChapter(s.id, { provider: 'mangadex', number: n });
  // ch4 was just bound into a CBZ but hasn't been promoted to 'imported' by the
  // next library scan yet — it must be just as protected as 'imported'.
  const ch4 = listChaptersForSeries(s.id).find(c => c.number === '4');
  setChapterState(ch4.id, 'bindery', { volume: '99', calculated: 1, cbz_path: '/tmp/fake.cbz' });

  resolveVolumes(s.id);
  const after = listChaptersForSeries(s.id).find(c => c.number === '4');
  assert.equal(after.volume, '99'); // unchanged
  assert.equal(after.state, 'bindery');
});
