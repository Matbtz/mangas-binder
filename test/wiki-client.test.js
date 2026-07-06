import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChapterVolumeMap } from '../src/providers/wiki-client.js';

// The wiki chapter-list parsers were written without live wiki access (network
// policy blocks wikipedia.org / fandom.com in the build env), so these fixtures
// mirror the documented templated formats. They pin the fail-closed contract and
// the two common shapes: EN {{Graphic novel list}} and a FR/other chapters table.

const obj = (m) => Object.fromEntries([...m.entries()]);

test('EN {{Graphic novel list}}: cumulative numbering maps chapters to their volume', () => {
  const wt = `
{{Graphic novel list
|VolumeNumber=1
|VolumeTitle=Romance Dawn
|OriginalRelDate=December 24, 1997
|ChapterList=
#"Romance Dawn"
#"They Call Him 'Straw Hat Luffy'"
#"Introducing 'Pirate Hunter' Roronoa Zoro"
#"The Great Captain Morgan"
#"The King of the Pirates and the Master Swordsman"
#"The First Person"
#"Friends"
#"Nami"
}}
{{Graphic novel list
|VolumeNumber=2
|ChapterList=
#"The Pirate 'Buggy the Clown'"
#"Damage Report"
#"Fine Theft"
#"Passing on the Dream"
#"Well, Now That That's Over"
#"You're a Trained Animal"
#"The Brat"
#"Luvre"
#"Honesty"
}}`;
  const { map, volumeTitles } = parseChapterVolumeMap(wt, 'en');
  const o = obj(map);
  assert.equal(o['1'], '1');
  assert.equal(o['8'], '1');
  assert.equal(o['9'], '2');   // cumulative continues into volume 2
  assert.equal(o['17'], '2');
  assert.equal(map.size, 17);
  assert.equal(volumeTitles.get('1'), 'Romance Dawn');
});

test('EN {{Graphic novel list}}: explicit leading chapter numbers are honoured over cumulative counting', () => {
  const wt = `
{{Graphic novel list
|VolumeNumber=1
|ChapterList=
#1. "One"
#2. "Two"
}}
{{Graphic novel list
|VolumeNumber=2
|ChapterList=
#3. "Three"
#4.5 – "Bonus"
}}`;
  const o = obj(parseChapterVolumeMap(wt, 'en').map);
  assert.equal(o['1'], '1');
  assert.equal(o['2'], '1');
  assert.equal(o['3'], '2');
  assert.equal(o['4.5'], '2'); // decimal side-chapter kept under its volume
});

test('FR/other chapters table: reads "N à M" ranges per volume', () => {
  const wt = `
{| class="wikitable"
|-
! Tome !! Date de sortie !! Chapitres
|-
| 1 || {{date|4|mars|2021}} || 1 à 8
|-
| 2 || {{date|4|juin|2021}} || 9 à 17
|-
| 3 || {{date|3|septembre|2021}} || 18 à 26
|}`;
  const o = obj(parseChapterVolumeMap(wt, 'fr').map);
  assert.equal(o['1'], '1');
  assert.equal(o['8'], '1');
  assert.equal(o['9'], '2');
  assert.equal(o['26'], '3');
});

test('chapters table: explicit comma-separated list of chapter numbers', () => {
  const wt = `
{| class="wikitable"
|-
! Volume !! Chapters
|-
| 1 || 1, 2, 3, 4
|-
| 2 || 5, 6, 7
|}`;
  const o = obj(parseChapterVolumeMap(wt).map);
  assert.deepEqual(o, { '1': '1', '2': '1', '3': '1', '4': '1', '5': '2', '6': '2', '7': '2' });
});

test('fails closed on wikitext with no recognisable chapter structure', () => {
  const { map } = parseChapterVolumeMap('This is just prose about a manga. No tables, no lists.', 'en');
  assert.equal(map.size, 0);
  assert.deepEqual(obj(parseChapterVolumeMap(null).map), {});
  assert.deepEqual(obj(parseChapterVolumeMap('').map), {});
});
