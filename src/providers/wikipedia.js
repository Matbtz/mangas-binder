import { apiBase, fetchWikitext, searchTitles, parseChapterVolumeMap } from './wiki-client.js';
import { normTitle } from '../core/text-match.js';

/**
 * Wikipedia per-chapter volume-map provider — the "structural authority" the
 * metadata-aggregation report recommends: Wikipedia's "List of <X> chapters"
 * tables mirror the physical tankōbon boundaries, so where they exist they beat
 * crowd-sourced MangaDex volume tags.
 *
 * Multilingual by design (cascade EN → FR): the report's Fool Night case has an
 * empty English chapter list but a complete French one, and the French manga
 * market keeps rigorous seinen bibliographies. The first language that yields a
 * non-empty map wins.
 *
 * Metadata-only + OFF by default (see settings.js): unlike the total-count
 * cross-checks, this writes *per-chapter* anchors that outrank MangaDex, and the
 * parsers (wiki-client.js) were built without live wiki access, so it's opt-in
 * until validated against real markup in a networked deployment. Everything fails
 * closed — an unresolved page or unparseable table yields no map, never a guess.
 */

const DEFAULT_LANGS = ['en', 'fr'];

/** Candidate page titles that hold a chapter→volume table, per language. */
function candidateTitles(title, lang) {
  if (lang === 'fr') {
    return [`Liste des chapitres de ${title}`, `${title} (manga)`, title];
  }
  // en + fallback
  return [`List of ${title} chapters`, `${title} (manga)`, title];
}

function host(lang) {
  return `${lang}.wikipedia.org`;
}

/**
 * Resolve a chapter→volume map for a series title.
 * @param {string} title
 * @param {{ langs?: string[] }} [opts]
 * @returns {Promise<{ map: Map<string,string>, volumeTitles: Map<string,string>,
 *   matchedTitle: string, sourceUrl: string, lang: string } | null>}
 */
export async function fetchChapterVolumeMap(title, { langs = DEFAULT_LANGS } = {}) {
  for (const lang of langs) {
    const base = apiBase(host(lang), '/w/api.php');

    // Build the candidate page list: constructed titles first (self-verifying,
    // we made them), then a search fallback restricted to title-matching hits.
    const candidates = [...candidateTitles(title, lang)];
    try {
      const found = await searchTitles(base, `${title} chapters`, 5);
      for (const t of found) if (!candidates.includes(t)) candidates.push(t);
    } catch { /* search is best-effort */ }

    for (const pageTitle of candidates) {
      const wikitext = await fetchWikitext(base, pageTitle);
      if (!wikitext) continue;
      // Guard: the page must actually be about this series (its normalised title
      // should appear in the lead) so a same-named unrelated page can't feed a map.
      if (!normTitle(wikitext.slice(0, 4000)).includes(normTitle(title))) continue;
      const { map, volumeTitles } = parseChapterVolumeMap(wikitext, lang);
      if (map.size > 0) {
        return {
          map, volumeTitles, matchedTitle: pageTitle, lang,
          sourceUrl: `https://${host(lang)}/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
        };
      }
    }
  }
  return null;
}

/** Lightweight reachability check for the Settings "Test connection" button. */
export async function testConnection() {
  const res = await fetchChapterVolumeMap('One Piece', { langs: ['en'] });
  if (!res) return { message: 'Reached Wikipedia, but could not parse a chapter list for the test title ("One Piece") — this integration is best-effort and needs live validation.' };
  return { message: `Reached Wikipedia (${res.sourceUrl}): mapped ${res.map.size} chapters across the volume list.` };
}

/**
 * Per-chapter volume-map provider (no totals, no downloads). Consumed by
 * core/chapter-map-consensus.js. `metadata: false` keeps it out of the Add-tab
 * search sources (it has no getSeries).
 */
export const provider = {
  name: 'wikipedia',
  label: 'Wikipedia',
  capabilities: { download: false, metadata: false },
  fetchChapterVolumeMap,
  testConnection,
};
