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
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { resolveVolumes } = await import('../src/core/mapping.js');
const { extrapolateVolumes, sanitizeVolumeMap } = await import('../src/core/extrapolate.js');
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
  const volumeMap = { '1': ['1', '2', '3'], '2': ['4', '5', '6'] };
  const { calculated, overflow } = extrapolateVolumes(volumeMap, ['7', '8', '9', '10', '11', '12'], 3);
  assert.deepEqual(calculated, { '3': ['7', '8', '9'] });
  assert.deepEqual(overflow, ['10', '11', '12']);
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
