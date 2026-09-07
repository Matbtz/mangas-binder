import { apiBase, fetchWikitext, searchTitles, parseChapterVolumeMap, looksLikeChapterList } from './wiki-client.js';
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
 * Metadata-only. It writes *per-chapter* anchors that outrank every other
 * source, so everything fails closed twice over: an unresolved page yields no
 * map, and a page the parser demonstrably misread is discarded by
 * `looksLikeChapterList()` rather than half-trusted (see wiki-client.js).
 */

const DEFAULT_LANGS = ['en', 'fr'];

// A long series' chapter list is often split across several pages; both bounds
// leave room for that without turning one lookup into a page-fetch storm.
const MAX_SEARCH_HITS = 10;
const MAX_PAGE_FETCHES = 8;

/** Candidate page titles that hold a chapter→volume table, per language. */
function candidateTitles(title, lang) {
  if (lang === 'fr') {
    return [`Liste des chapitres de ${title}`, `Liste des volumes de ${title}`, `${title} (manga)`, title];
  }
  // en + fallback
  return [`List of ${title} chapters`, `List of ${title} volumes`, `${title} (manga)`, title];
}

function host(lang) {
  return `${lang}.wikipedia.org`;
}

function pageUrl(lang, pageTitle) {
  return `https://${host(lang)}/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`;
}

/**
 * True for a page that *is* the series' chapter list, as opposed to a volume
 * list or the article itself. Split chapter lists ("List of Bleach chapters
 * (1–187)") match, which is what lets them be merged below.
 */
function isChapterListPage(pageTitle, seriesTitle, lang) {
  if (!normTitle(pageTitle).includes(normTitle(seriesTitle))) return false;
  return lang === 'fr' ? /chapitres/i.test(pageTitle) : /\bchapters?\b/i.test(pageTitle);
}

const lowestChapter = map => Math.min(...[...map.keys()].map(parseFloat).filter(Number.isFinite));
const volumeSpread = map => new Set([...map.values()]).size;

/**
 * Resolve a chapter→volume map for a series title.
 *
 * Candidate pages are all parsed and then *combined*, rather than taking the
 * first one that yields anything. Two things forced that change, both found on
 * the live English Wikipedia while diagnosing Bleach:
 *
 *  - A long series' chapter list is split by range — "List of Bleach chapters
 *    (1–187)", "(188–423)", "(424–686)" — and each page alone covers only its
 *    slice. Merged they describe all 74 volumes and 690 chapters exactly; taken
 *    one at a time, whichever came back first would have claimed the series ends
 *    at volume 21.
 *  - "List of Bleach chapters" is a redirect stub with no table, so the old
 *    first-non-empty loop fell through to "List of Bleach volumes", whose layout
 *    this parser reads as 643 chapters spread over 25 volumes — wrong, but not
 *    obviously so. Chapter-list pages therefore outrank every other page shape,
 *    and a volume list is only consulted when no chapter list parses at all.
 *
 * @param {string} title
 * @param {{ langs?: string[] }} [opts]
 * @returns {Promise<{ map: Map<string,string>, volumeTitles: Map<string,string>,
 *   matchedTitle: string, sourceUrl: string, lang: string, pages?: string[] } | null>}
 */
export async function fetchChapterVolumeMap(title, { langs = DEFAULT_LANGS } = {}) {
  for (const lang of langs) {
    const base = apiBase(host(lang), '/w/api.php');

    // Build the candidate page list: constructed titles first (self-verifying,
    // we made them), then a search fallback restricted to title-matching hits.
    const candidates = [...candidateTitles(title, lang)];
    try {
      const found = await searchTitles(base, `${title} chapters`, MAX_SEARCH_HITS);
      for (const t of found) if (!candidates.includes(t)) candidates.push(t);
    } catch { /* search is best-effort */ }

    const parsed = [];
    let fetches = 0;
    for (const pageTitle of candidates) {
      if (fetches >= MAX_PAGE_FETCHES) break;
      const wikitext = await fetchWikitext(base, pageTitle);
      fetches++;
      if (!wikitext) continue;
      // Guard: the page must actually be about this series (its normalised title
      // should appear in the lead) so a same-named unrelated page can't feed a map.
      if (!normTitle(wikitext.slice(0, 4000)).includes(normTitle(title))) continue;
      const { map, volumeTitles } = parseChapterVolumeMap(wikitext, lang);
      // Fail closed on a page whose table this parser clearly misread, rather
      // than passing scattered noise down to the volume estimator.
      if (!looksLikeChapterList(map)) continue;
      parsed.push({ pageTitle, map, volumeTitles, chapterList: isChapterListPage(pageTitle, title, lang) });
    }
    if (!parsed.length) continue;

    const parts = parsed.filter(p => p.chapterList);
    if (parts.length) {
      // Split ranges are disjoint, so merging in chapter order is unambiguous;
      // first writer wins on the rare overlap (the earlier page is the more
      // specific one for that range).
      parts.sort((a, b) => lowestChapter(a.map) - lowestChapter(b.map));
      const map = new Map();
      const volumeTitles = new Map();
      for (const p of parts) {
        for (const [ch, vol] of p.map) if (!map.has(ch)) map.set(ch, vol);
        for (const [vol, t] of p.volumeTitles) if (!volumeTitles.has(vol)) volumeTitles.set(vol, t);
      }
      return {
        map, volumeTitles, lang,
        matchedTitle: parts.length === 1 ? parts[0].pageTitle : `${parts[0].pageTitle} (+${parts.length - 1} more)`,
        sourceUrl: pageUrl(lang, parts[0].pageTitle),
        pages: parts.map(p => p.pageTitle),
      };
    }

    // No chapter-list page parsed — fall back to whichever other page describes
    // the most volumes (a volume list, or the article's own table).
    const best = parsed.reduce((a, b) => (volumeSpread(b.map) > volumeSpread(a.map) ? b : a));
    return {
      map: best.map, volumeTitles: best.volumeTitles, lang,
      matchedTitle: best.pageTitle,
      sourceUrl: pageUrl(lang, best.pageTitle),
      pages: [best.pageTitle],
    };
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
