import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Gap-fill synthesises placeholder chapters `1..latestChapter` (tagged with a
// `synth-` provider_chapter_id) on every refresh. A run whose consensus
// latest-chapter was once too high leaves orphaned placeholders behind that no
// later run removes — a finished 55-chapter series ("Pet") was observed holding
// 135 chapters, inflating every estimated volume. pruneSyntheticChaptersBeyond()
// cleans them up, touching only never-downloaded, still-synthetic rows.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-phantom-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState, pruneSyntheticChaptersBeyond } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

test('pruneSyntheticChaptersBeyond removes stale placeholders past the consensus, keeps everything real or in-progress', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'ph1', title: 'Phantom One', language: 'en', monitored: true, packagingMode: 'volume' });

  // 1..55: genuine chapters carrying a real provider id.
  for (let i = 1; i <= 55; i++) upsertChapter(s.id, { provider: 'mangadex', providerChapterId: `real-${i}`, number: String(i) });
  // 56..135: stale gap-fill placeholders from a run whose latest-chapter was wrong-high.
  for (let i = 56; i <= 135; i++) upsertChapter(s.id, { provider: 'mangadex', providerChapterId: `synth-${s.id}-${i}`, number: String(i) });

  // A placeholder past the cap that the user actually started downloading must
  // be protected (attempts > 0), and a genuinely-downloaded one too.
  const chs0 = listChaptersForSeries(s.id);
  setChapterState(chs0.find(c => c.number === '60').id, 'downloaded', { attempts: 1 });
  setChapterState(chs0.find(c => c.number === '61').id, 'wanted', { attempts: 2 });

  const removed = pruneSyntheticChaptersBeyond(s.id, 55);
  assert.equal(removed, 78, 'chapters 56-135 minus the two protected ones');

  const nums = listChaptersForSeries(s.id).map(c => parseFloat(c.number)).sort((a, b) => a - b);
  assert.equal(Math.max(...nums), 61, 'nothing synthetic past 55 survives except the protected rows');
  for (let i = 1; i <= 55; i++) assert.ok(nums.includes(i), `real chapter ${i} kept`);
  assert.ok(nums.includes(60) && nums.includes(61), 'attempted/downloaded placeholders kept');
});

test('pruneSyntheticChaptersBeyond never touches real chapters numbered past the cap (provider is ahead of the consensus)', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'ph2', title: 'Phantom Two', language: 'en', monitored: true, packagingMode: 'volume' });
  // The primary provider legitimately lists chapters past a lagging consensus —
  // these carry real ids (never synthetic) and must be left alone.
  for (let i = 1; i <= 60; i++) upsertChapter(s.id, { provider: 'mangadex', providerChapterId: `real-${i}`, number: String(i) });

  const removed = pruneSyntheticChaptersBeyond(s.id, 55);
  assert.equal(removed, 0);
  assert.equal(listChaptersForSeries(s.id).length, 60);
});

test('pruneSyntheticChaptersBeyond is a no-op without a known cap', () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'ph3', title: 'Phantom Three', language: 'en', monitored: true, packagingMode: 'volume' });
  for (let i = 1; i <= 10; i++) upsertChapter(s.id, { provider: 'mangadex', providerChapterId: `synth-${s.id}-${i}`, number: String(i) });
  assert.equal(pruneSyntheticChaptersBeyond(s.id, null), 0);
  assert.equal(pruneSyntheticChaptersBeyond(s.id, 0), 0);
  assert.equal(listChaptersForSeries(s.id).length, 10);
});
