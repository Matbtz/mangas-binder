import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConsensus, impliesImpossibleChaptersPerVolume } from '../src/core/volume-consensus.js';

// Regression for a real production bug: MangaUpdates' own latest_chapter
// field was badly stale for an older completed series ("20th Century Boys"
// reported 13 despite being a finished, 249-chapter work) while MangaBaka and
// Fandom's wiki infobox both independently agreed on 249. A single-provider
// fallback chain can't reliably tell a stale number from a good one, so every
// enabled provider's opinion is resolved by majority vote instead of trusting
// one provider outright.

test('resolveConsensus: when one provider disagrees and the rest agree, the majority value wins', () => {
  const result = resolveConsensus([
    { provider: 'mangaupdates', value: 13 },
    { provider: 'mangabaka', value: 249 },
    { provider: 'fandom', value: 249 },
  ]);
  assert.equal(result.value, 249);
  assert.equal(result.confidence, 2 / 3);
  assert.deepEqual(result.agreeing.sort(), ['fandom', 'mangabaka']);
  assert.deepEqual(result.dissenting, ['mangaupdates']);
});

test('resolveConsensus: unanimous agreement gives full confidence', () => {
  const result = resolveConsensus([
    { provider: 'mangaupdates', value: 115 },
    { provider: 'mangabaka', value: 115 },
  ]);
  assert.equal(result.value, 115);
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.dissenting, []);
});

test('resolveConsensus: a 1-vs-1 tie is broken by provider priority order, not just the higher number', () => {
  const result = resolveConsensus(
    [
      { provider: 'fandom', value: 999 }, // higher number, but lower-priority source
      { provider: 'mangaupdates', value: 27 },
    ],
    ['mangaupdates', 'mangabaka', 'fandom'],
  );
  assert.equal(result.value, 27);
  assert.equal(result.confidence, 0.5);
});

test('impliesImpossibleChaptersPerVolume: flags physically impossible pairings, ignores unknowns', () => {
  // "Pet": a real 5-volume / 55-chapter series that MangaUpdates reported as 1
  // volume — 55 chapters can't fit in a single volume.
  assert.equal(impliesImpossibleChaptersPerVolume(1, 55), true);
  // "20th Century Boys": MangaUpdates' stale latest_chapter (13) against its own
  // 13-volume count implies 1 chapter/volume — impossible.
  assert.equal(impliesImpossibleChaptersPerVolume(13, 13), true);
  // Normal manga distributions are fine.
  assert.equal(impliesImpossibleChaptersPerVolume(5, 55), false);
  assert.equal(impliesImpossibleChaptersPerVolume(22, 249), false);
  // An unknown on either side can't contradict anything.
  assert.equal(impliesImpossibleChaptersPerVolume(1, null), false);
  assert.equal(impliesImpossibleChaptersPerVolume(null, 55), false);
});

test('resolveConsensus: a genuine tie in both count and priority prefers the higher value', () => {
  // Two providers not in the priority list at all, disagreeing 1-vs-1.
  const result = resolveConsensus([
    { provider: 'x', value: 10 },
    { provider: 'y', value: 20 },
  ], ['mangaupdates']);
  assert.equal(result.value, 20);
});

test('resolveConsensus: ignores null/missing opinions and only votes among providers that actually answered', () => {
  const result = resolveConsensus([
    { provider: 'mangaupdates', value: null },
    { provider: 'fandom', value: null }, // e.g. still-ongoing series, reports null rather than guessing
    { provider: 'mangabaka', value: 100 },
  ]);
  assert.equal(result.value, 100);
  assert.equal(result.confidence, 1); // 1 of 1 *valid* opinions
  assert.deepEqual(result.dissenting, []);
});

test('resolveConsensus: no provider has an opinion at all — an abstention is not a dissent', () => {
  const result = resolveConsensus([{ provider: 'mangaupdates', value: null }]);
  assert.equal(result.value, null);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.dissenting, []);
});

test('resolveConsensus: empty opinions array', () => {
  const result = resolveConsensus([]);
  assert.equal(result.value, null);
  assert.equal(result.confidence, 0);
});
