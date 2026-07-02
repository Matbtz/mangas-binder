import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConsensus } from '../src/core/volume-consensus.js';

// Regression for a real production bug: MangaUpdates' own latest_chapter
// field was badly stale for an older completed series ("20th Century Boys"
// reported 13 despite being a finished, 249-chapter work) while AniList,
// MangaBaka, and Fandom's wiki infobox all independently agreed on 249. A
// single-provider fallback chain can't reliably tell a stale number from a
// good one, so every enabled provider's opinion is resolved by majority vote
// instead of trusting one provider outright.

test('resolveConsensus: when one provider disagrees and the rest agree, the majority value wins', () => {
  const result = resolveConsensus([
    { provider: 'mangaupdates', value: 13 },
    { provider: 'anilist', value: 249 },
    { provider: 'mangabaka', value: 249 },
    { provider: 'fandom', value: 249 },
  ]);
  assert.equal(result.value, 249);
  assert.equal(result.confidence, 0.75);
  assert.deepEqual(result.agreeing.sort(), ['anilist', 'fandom', 'mangabaka']);
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
    ['mangaupdates', 'anilist', 'mangabaka', 'fandom'],
  );
  assert.equal(result.value, 27);
  assert.equal(result.confidence, 0.5);
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
    { provider: 'anilist', value: null }, // e.g. still-ongoing series, AniList reports null rather than guessing
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
