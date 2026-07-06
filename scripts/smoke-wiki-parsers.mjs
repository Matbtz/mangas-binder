#!/usr/bin/env node
/**
 * Manual, one-off smoke test for the Wikipedia/Fandom chapter→volume parsers
 * (src/providers/wiki-client.js, wikipedia.js, fandom.js). NOT part of the
 * automated test suite (never run by `node --test` or CI) — the sandbox this
 * was built in blocks outbound requests to wikipedia.org/fandom.com by network
 * policy, so those parsers were written fail-closed against fixtures but never
 * validated against real, live wiki markup.
 *
 * Run this manually, with real network access, BEFORE enabling the `wikipedia`
 * provider (it's off by default — see core/settings.js) in a real deployment:
 *
 *   node scripts/smoke-wiki-parsers.mjs
 *
 * It exercises three representative cases from the metadata-aggregation report
 * this feature implements and prints what each parser actually resolved, so you
 * can eyeball it against the real chapter list before trusting it to anchor
 * volume boundaries in your library.
 */
import { provider as wikipedia } from '../src/providers/wikipedia.js';
import { provider as fandom } from '../src/providers/fandom.js';

function printMap(label, result) {
  console.log(`\n=== ${label} ===`);
  if (!result) { console.log('  -> null (no page found / parse failed / nothing verified)'); return; }
  console.log(`  matchedTitle: ${result.matchedTitle}`);
  if (result.sourceUrl) console.log(`  sourceUrl:    ${result.sourceUrl}`);
  if (result.lang) console.log(`  lang:         ${result.lang}`);
  console.log(`  chapters mapped: ${result.map.size}`);
  const entries = [...result.map.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  const sample = entries.slice(0, 5).map(([ch, vol]) => `ch${ch}->v${vol}`).join(', ');
  const tail = entries.slice(-5).map(([ch, vol]) => `ch${ch}->v${vol}`).join(', ');
  console.log(`  first few: ${sample}`);
  console.log(`  last few:  ${tail}`);
  if (result.volumeTitles?.size) {
    console.log(`  volume titles: ${[...result.volumeTitles.entries()].slice(0, 5).map(([v, t]) => `v${v}="${t}"`).join(', ')}`);
  }
}

async function main() {
  console.log('Wiki chapter-map parser smoke test — verify against the real chapter lists before enabling the "wikipedia" provider.\n');

  // Fool Night: EN Wikipedia/Fandom are known-empty per the report; the FR
  // Wikipedia chapter list is expected to carry the full vol 1-13 mapping.
  printMap('Wikipedia: Fool Night (EN→FR cascade)', await wikipedia.fetchChapterVolumeMap('Fool Night', { langs: ['en', 'fr'] }).catch(e => { console.error(e); return null; }));

  // Dandadan: EN Wikipedia is known to lag past vol 6; Fandom is expected to
  // cover the full run via its per-volume category pages.
  printMap('Fandom: Dandadan (deep per-volume coverage)', await fandom.fetchChapterVolumeMap('Dandadan').catch(e => { console.error(e); return null; }));

  // One Piece: flagship EN Wikipedia {{Graphic novel list}} coverage, plus the
  // out-of-sequence volumes (0, 777/Stampede) the report calls out.
  printMap('Wikipedia: One Piece (EN {{Graphic novel list}})', await wikipedia.fetchChapterVolumeMap('One Piece', { langs: ['en'] }).catch(e => { console.error(e); return null; }));

  console.log('\nDone. If any of these look wrong (missing chapters, wrong volumes,\n' +
    'garbage titles), fix wiki-client.js\'s parser before enabling "wikipedia"\n' +
    'in Settings — it stays opt-in specifically until this has been checked.');
}

main();
