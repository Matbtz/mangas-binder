import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB/paths before any module reads config.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-dist-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, getSeries, upsertChapter, listChaptersForSeries, updateSeries, setChapterState } = await import('../src/core/repo.js');
const { sanitizeVolumeMap, extrapolateVolumes, evenVolumeSplit } = await import('../src/core/extrapolate.js');
const { resolveVolumes, manualVolumeFor, applyManualDistribution, manualDistributionOf } = await import('../src/core/mapping.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
const sizesOf = calculated => Object.keys(calculated).filter(v => v !== 'Specials')
  .sort((a, b) => parseFloat(a) - parseFloat(b)).map(v => calculated[v].length);

/**
 * The Bleach shape, from the live MangaUpdates release feed: 43 tagged volumes
 * across a 74-volume / 686-chapter series, most of them holding one or two
 * chapters instead of the ~9 a volume really has.
 */
function bleachLikeAnchors() {
  const perVolume = {
    1: 3, 5: 2, 6: 2, 7: 9, 8: 1, 14: 1, 16: 7, 17: 5, 18: 7, 19: 2, 23: 3, 24: 2,
    25: 1, 26: 1, 31: 1, 35: 2, 40: 9, 41: 9, 42: 9, 43: 1, 44: 3, 45: 9, 46: 9,
    47: 9, 48: 10, 49: 9, 50: 9, 51: 9, 52: 8, 53: 11, 54: 10, 55: 9,
    56: 1, 57: 1, 58: 1, 59: 1, 60: 1, 61: 1, 62: 1, 63: 1, 64: 1, 65: 1, 66: 1,
  };
  const volumeMap = {};
  const tagged = new Set();
  for (const [vol, count] of Object.entries(perVolume)) {
    const start = Math.round(((vol - 1) * 686) / 74) + 1;
    volumeMap[vol] = [];
    for (let i = 0; i < count; i++) { volumeMap[vol].push(String(start + i)); tagged.add(String(start + i)); }
  }
  return { volumeMap, unassigned: range(1, 686).filter(n => !tagged.has(n)) };
}

test('sanitizeVolumeMap: trims one-chapter anchors out of a map that covers only a sliver of each volume', () => {
  const { volumeMap } = bleachLikeAnchors();
  const { cleanVolumeMap, noisy } = sanitizeVolumeMap(volumeMap, { totalVolumesHint: 74, totalChaptersHint: 686 });
  // Volumes tagged with a single chapter are incomplete tags, not boundaries.
  for (const v of ['8', '14', '25', '26', '31', '43', '56', '60', '66']) {
    assert.equal(v in cleanVolumeMap, false, `thin anchor ${v} should be demoted`);
  }
  // Volumes tagged with a full volume's worth stay authoritative.
  for (const v of ['7', '16', '18', '40', '48', '53']) {
    assert.ok(v in cleanVolumeMap, `well-covered anchor ${v} must survive`);
  }
  assert.ok(noisy.length > 0);
});

test('sanitizeVolumeMap: a densely tagged series keeps even its small volumes', () => {
  // 85%+ coverage means the map is complete, so a short volume is a real one.
  const volumeMap = {}; let ch = 1;
  for (let v = 1; v <= 20; v++) { const n = v === 7 ? 3 : 10; volumeMap[String(v)] = range(ch, ch + n - 1); ch += n; }
  const { cleanVolumeMap, noisy } = sanitizeVolumeMap(volumeMap, { totalVolumesHint: 20, totalChaptersHint: 193 });
  assert.ok('7' in cleanVolumeMap, 'a genuinely short volume in a complete map is not trimmed');
  assert.deepEqual(noisy, []);
});

test('extrapolateVolumes: the Bleach anchor set yields 74 even volumes, not 1-chapter and 25-chapter ones', () => {
  const { volumeMap, unassigned } = bleachLikeAnchors();
  const { cleanVolumeMap } = sanitizeVolumeMap(volumeMap, { totalVolumesHint: 74, totalChaptersHint: 686 });
  const { calculated, overflow } = extrapolateVolumes(volumeMap, unassigned, 74, false, null, 686);
  assert.deepEqual(overflow, []);

  const final = {};
  for (const [v, chs] of Object.entries(cleanVolumeMap)) final[v] = (final[v] || 0) + chs.length;
  for (const [v, chs] of Object.entries(calculated)) final[v] = (final[v] || 0) + chs.length;

  const vols = Object.keys(final).filter(v => v !== 'Specials').map(Number).sort((a, b) => a - b);
  assert.equal(vols[0], 1);
  assert.equal(vols[vols.length - 1], 74);
  assert.equal(vols.length, 74, 'every volume is used, none skipped');
  const counts = vols.map(v => final[String(v)]);
  assert.ok(Math.min(...counts) >= 6, `no starved volume, got min ${Math.min(...counts)}`);
  assert.ok(Math.max(...counts) <= 14, `no ballooned volume, got max ${Math.max(...counts)}`);
});

test('extrapolateVolumes: a well-covered anchor keeps its exact boundaries', () => {
  // Volumes 1-3 are fully tagged at 9 chapters each; the rest is untagged. The
  // tagged volumes must come out untouched, not absorb neighbouring chapters.
  const volumeMap = { 1: range(1, 9), 2: range(10, 18), 3: range(19, 27) };
  const { calculated } = extrapolateVolumes(volumeMap, range(28, 90), 10, false, null, 90);
  assert.equal(calculated['1'], undefined, 'volume 1 is fully described by its anchor');
  assert.equal(calculated['2'], undefined);
  assert.equal(calculated['3'], undefined);
  const tailSizes = sizesOf(calculated);
  assert.ok(Math.max(...tailSizes) - Math.min(...tailSizes) <= 1, `tail is even, got ${tailSizes}`);
});

test('extrapolateVolumes: a thin anchor no longer starves its own volume', () => {
  // Volumes 5 and 6 are each tagged with a single chapter, adjacent to one
  // another. Read as boundaries they would leave volume 6 holding one chapter;
  // read as membership hints they just constrain an otherwise even split.
  const volumeMap = { 5: ['45'], 6: ['46'] };
  const tagged = new Set(['45', '46']);
  const { calculated } = extrapolateVolumes(volumeMap, range(1, 100).filter(n => !tagged.has(n)), 10, false, null, 100);
  const sizes = sizesOf(calculated);
  assert.ok(Math.min(...sizes) >= 8, `no starved volume, got ${sizes}`);
  assert.ok(Math.max(...sizes) <= 12, `no ballooned volume, got ${sizes}`);
});

test('evenVolumeSplit: equal shares, all volumes used, fractional chapters to Specials', () => {
  const out = evenVolumeSplit([...range(1, 686), '12.5'], 74);
  const vols = Object.keys(out).filter(v => v !== 'Specials').map(Number).sort((a, b) => a - b);
  assert.equal(vols.length, 74);
  assert.deepEqual(out['Specials'], ['12.5']);
  const counts = vols.map(v => out[String(v)].length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `even, got ${counts}`);
  assert.equal(counts.reduce((a, b) => a + b, 0), 686);
});

// --- Manual "N chapters over V volumes" -------------------------------------

test('manualVolumeFor: even boundaries, ends exactly on the last volume', () => {
  assert.equal(manualVolumeFor('1', 686, 74), '1');
  assert.equal(manualVolumeFor('9', 686, 74), '1');
  assert.equal(manualVolumeFor('10', 686, 74), '2');
  assert.equal(manualVolumeFor('686', 686, 74), '74');
  // Past the stated total: clamp into the last volume, never invent volume 75.
  assert.equal(manualVolumeFor('700', 686, 74), '74');
  assert.equal(manualVolumeFor('12.5', 686, 74), 'Specials');
});

test('applyManualDistribution: spreads every chapter evenly and survives a re-resolve', () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'manual1', title: 'Manual One', language: 'en',
    monitored: true, packagingMode: 'volume',
  });
  for (const n of range(1, 100)) upsertChapter(s.id, { provider: 'mangadex', number: n });
  updateSeries(s.id, { manualTotalChapters: 100, manualTotalVolumes: 10 });

  const { assigned } = applyManualDistribution(s.id);
  assert.equal(assigned, 100);
  const byVol = {};
  for (const c of listChaptersForSeries(s.id)) byVol[c.volume] = (byVol[c.volume] || 0) + 1;
  assert.deepEqual(Object.keys(byVol).map(Number).sort((a, b) => a - b), range(1, 10).map(Number));
  assert.deepEqual([...new Set(Object.values(byVol))], [10], 'every volume holds exactly 10');

  // resolveVolumes must re-apply the pin, not hand the series back to the estimator.
  resolveVolumes(s.id);
  const after = {};
  for (const c of listChaptersForSeries(s.id)) after[c.volume] = (after[c.volume] || 0) + 1;
  assert.deepEqual(after, byVol);
});

test('applyManualDistribution: an already-packaged chapter keeps the volume its CBZ was built with', () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'manual2', title: 'Manual Two', language: 'en',
    monitored: true, packagingMode: 'volume',
  });
  for (const n of range(1, 50)) upsertChapter(s.id, { provider: 'mangadex', number: n });
  const ch3 = listChaptersForSeries(s.id).find(c => c.number === '3');
  setChapterState(ch3.id, 'imported', { volume: '99', calculated: 1 });
  updateSeries(s.id, { manualTotalChapters: 50, manualTotalVolumes: 5 });

  const { skippedPackaged } = applyManualDistribution(s.id);
  assert.equal(skippedPackaged, 1);
  assert.equal(listChaptersForSeries(s.id).find(c => c.number === '3').volume, '99');
  assert.equal(listChaptersForSeries(s.id).find(c => c.number === '4').volume, '1');
});

test('manualDistributionOf: releasing the pin returns the series to automatic estimation', () => {
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'manual3', title: 'Manual Three', language: 'en',
    monitored: true, packagingMode: 'volume', totalVolumesHint: 4, totalChaptersHint: 40,
  });
  for (const n of range(1, 40)) upsertChapter(s.id, { provider: 'mangadex', number: n });
  updateSeries(s.id, { manualTotalChapters: 40, manualTotalVolumes: 8 });
  resolveVolumes(s.id);
  assert.equal(new Set(listChaptersForSeries(s.id).map(c => c.volume)).size, 8);

  updateSeries(s.id, { manualTotalChapters: null, manualTotalVolumes: null });
  assert.equal(manualDistributionOf(getSeries(s.id)), null);
  resolveVolumes(s.id);
  // Back to the consensus hints (4 volumes), not the released 8.
  const vols = new Set(listChaptersForSeries(s.id).map(c => Number(c.volume)));
  assert.equal(Math.max(...vols), 4);
});

test('sanitizeVolumeMap: a complete map that skips one volume has the hole reopened', () => {
  // Live case: Wikipedia's Bleach chapter lists cover all 686 chapters but jump
  // from volume 35 straight to 37 — a lost table row. Both neighbours look
  // complete, so left alone they pin their boundaries and volume 36 comes out
  // empty: a missing tome in the library.
  const volumeMap = {}; let ch = 1;
  for (let v = 1; v <= 40; v++) {
    if (v === 36) continue;
    volumeMap[String(v)] = range(ch, ch + 9); ch += 10;
  }
  const { cleanVolumeMap, noisy } = sanitizeVolumeMap(volumeMap, { totalVolumesHint: 40, totalChaptersHint: 390 });
  assert.equal('35' in cleanVolumeMap, false, 'the anchor below the hole is reopened');
  assert.equal('37' in cleanVolumeMap, false, 'the anchor above the hole is reopened');
  assert.ok('34' in cleanVolumeMap && '38' in cleanVolumeMap, 'anchors away from the hole are untouched');
  assert.equal(noisy.length, 20);
});

test('sanitizeVolumeMap: a partial map full of untagged volumes is not treated as full of holes', () => {
  // MangaUpdates' Bleach release map tags 43 of 74 volumes; every untagged one
  // would be a "hole". The repair must stand down — missing volumes are simply
  // what a partial map looks like.
  const volumeMap = { 1: range(1, 9), 10: range(91, 99), 20: range(191, 199) };
  const { cleanVolumeMap } = sanitizeVolumeMap(volumeMap, { totalVolumesHint: 74, totalChaptersHint: 686 });
  for (const v of ['1', '10', '20']) assert.ok(v in cleanVolumeMap, `sparse anchor ${v} survives`);
});

test('extrapolateVolumes: a dropped volume is refilled instead of leaving an empty tome', () => {
  const volumeMap = {}; const tagged = new Set(); let ch = 1;
  for (let v = 1; v <= 40; v++) {
    if (v === 36) continue;
    volumeMap[String(v)] = range(ch, ch + 9);
    for (const n of volumeMap[String(v)]) tagged.add(n);
    ch += 10;
  }
  const { cleanVolumeMap } = sanitizeVolumeMap(volumeMap, { totalVolumesHint: 40, totalChaptersHint: 390 });
  const { calculated } = extrapolateVolumes(volumeMap, range(1, 390).filter(n => !tagged.has(n)), 40, false, null, 390);
  const final = {};
  for (const [v, chs] of Object.entries(cleanVolumeMap)) final[v] = (final[v] || 0) + chs.length;
  for (const [v, chs] of Object.entries(calculated)) final[v] = (final[v] || 0) + chs.length;
  const vols = Object.keys(final).filter(v => v !== 'Specials').map(Number).sort((a, b) => a - b);
  assert.equal(vols.length, 40, 'all 40 volumes hold chapters');
  assert.ok(final['36'] > 0, 'the skipped volume is no longer empty');
});
