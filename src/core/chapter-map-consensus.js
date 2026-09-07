import { provider as wikipedia } from '../providers/wikipedia.js';
import { provider as fandom } from '../providers/fandom.js';
import { fetchChapterVolumeMap as muFetchChapterVolumeMap } from '../providers/mangaupdates.js';
import { impliesImpossibleChaptersPerVolume } from './volume-consensus.js';
import { isProviderEnabled } from './settings.js';

/**
 * Cross-provider consensus for the *per-chapter* volume map — the layer the
 * metadata-aggregation report calls for on top of the total-count consensus in
 * volume-consensus.js. Where a source knows which physical volume a chapter
 * belongs to, we use it directly instead of extrapolating.
 *
 * Source priority (lowest → highest; a higher source overwrites a lower one for
 * the same chapter). This encodes the report's core rule — sources that mirror
 * the physical print editions outrank crowd-sourced tags:
 *
 *   mangadex tags  <  mangaupdates releases  <  fandom  <  wikipedia
 *
 * MangaDex tags are the existing baseline; MangaUpdates releases keep their
 * existing precedence over them; Fandom and Wikipedia (print-edition chapter
 * lists) sit on top. With Wikipedia/Fandom disabled or empty, the result is
 * identical to today's mangadex→mangaupdates behaviour, so this never regresses
 * a series those two don't cover.
 *
 * Every source's map is gap-guarded: a source whose highest volume number is
 * physically impossible for the chapter count (a mis-parsed table implying <2 or
 * >40 chapters/volume, or a volume past a high-confidence total) is rejected
 * wholesale rather than allowed to poison the anchors — the same plausibility
 * test the totals consensus uses.
 *
 * CACHING: MangaUpdates/Fandom/Wikipedia (the "external" sources, as opposed to
 * MangaDex which is always re-fetched fresh as part of the regular chapter list)
 * are the slow, rate-limited, scraping-heavy part of this resolution. Their
 * result is split out as `fetchExternalChapterSources()` so a caller can cache
 * it on the series row (see repo.js's `chapterMapCache` column) and pass it back
 * in as `cachedExternal` to skip the network entirely on a cache hit —
 * `resolveChapterVolumeMap()` just overlays it on a freshly-built MangaDex
 * baseline, which is equivalent to a full re-resolution since external sources
 * always outrank MangaDex anyway.
 */

const key = (n) => String(parseFloat(n));

// Absolute ceiling for a chapter number when we have no consensus to size
// against. Mirrors providers/wiki-client.js's own cap.
const MAX_PLAUSIBLE_CHAPTER = 5000;

// How far a source's own chapters-per-volume may sit above the consensus before
// it reads as "this source merged volumes together" rather than "this source
// tagged part of the series". Only an *excess* is suspicious: a partial map
// legitimately carries fewer chapters per volume than the real thing.
const MERGED_VOLUMES_RATIO = 1.75;

/**
 * Vet one source's map against everything we know about the series, returning a
 * cleaned copy plus whether it is fit to use.
 *
 * Entries are pruned *before* the map is judged, which is the important part: a
 * single junk entry used to condemn an entire source. Live case — Wikipedia's
 * Bleach page yielded 646 good chapter→volume pairs plus one whose "chapter
 * number" was an Internet Archive timestamp scraped out of a citation; that lone
 * entry made the map's implied chapters-per-volume astronomical and the whole
 * source was dropped, leaving the estimator with MangaUpdates' 20 one-chapter
 * anchors and no real volume boundaries at all.
 *
 * @returns {{ map: Map<string,string>, ok: boolean, reason?: string, dropped: number }}
 */
function vetSourceMap(rawMap, { chapterCount = 0, totalVolumesHint = null, totalChaptersHint = null } = {}) {
  if (!rawMap || rawMap.size === 0) return { map: new Map(), ok: false, reason: 'empty', dropped: 0 };

  const volCap = totalVolumesHint > 0 ? Math.floor(totalVolumesHint) * 1.5 + 1 : null;
  const chCap = totalChaptersHint > 0
    ? Math.max(totalChaptersHint * 1.5 + 50, chapterCount * 1.5 + 50)
    : MAX_PLAUSIBLE_CHAPTER;

  const map = new Map();
  let dropped = 0, maxVol = 0, maxCh = 0;
  for (const [ch, vol] of rawMap) {
    const cn = parseFloat(ch), vn = parseFloat(vol);
    if (!Number.isFinite(cn) || !Number.isFinite(vn) || vn <= 0 || cn < 0) { dropped++; continue; }
    if (cn > chCap || (volCap != null && vn > volCap)) { dropped++; continue; }
    map.set(ch, vol);
    if (vn > maxVol) maxVol = vn;
    if (cn > maxCh) maxCh = cn;
  }
  if (!map.size) return { map, ok: false, reason: 'no usable entries', dropped };

  // Highest volume vs highest chapter must imply a sane chapters-per-volume —
  // catches a mis-parsed table (e.g. chapter 100 tagged "volume 2", or a page
  // whose numbers were read as volumes) before it can seed wrong anchors.
  if (impliesImpossibleChaptersPerVolume(maxVol, Math.max(maxCh, chapterCount))) {
    return { map, ok: false, reason: 'implied chapters-per-volume outside the physical band', dropped };
  }

  // A source that maps most of the run into far fewer volumes than the series
  // really has read the wrong edition or the wrong column — Wikipedia's
  // "List of Bleach volumes" page parses as 643 chapters across 25 volumes (26
  // per volume) against a 74-volume/686-chapter consensus (9 per volume). That
  // is inside the absolute band above yet nearly 3x the truth, so it needs the
  // consensus to be caught.
  if (totalVolumesHint > 0 && totalChaptersHint > 0) {
    const consensusPerVolume = totalChaptersHint / totalVolumesHint;
    const sourcePerVolume = map.size / new Set([...map.values()]).size;
    if (sourcePerVolume > consensusPerVolume * MERGED_VOLUMES_RATIO) {
      return { map, ok: false, reason: 'volumes look merged against the consensus', dropped };
    }
  }

  return { map, ok: true, dropped };
}

/**
 * Resolve just the external (non-MangaDex) sources: MangaUpdates releases,
 * Fandom, Wikipedia — in ascending priority order, each plausibility-guarded.
 * This is the part worth caching (see module docstring).
 *
 * @param {string} seriesTitle
 * @param {{ mangaUpdatesRef?:{seriesId:any,seriesTitle?:string}|null, totalVolumesHint?:number|null, totalChaptersHint?:number|null, chapterCount?:number }} [opts]
 * @returns {Promise<{ map: Map<string,{volume:string, source:string}>, volumeTitles: Map<string,string>, reports: Array<object> }>}
 */
export async function fetchExternalChapterSources(seriesTitle, { mangaUpdatesRef = null, totalVolumesHint = null, totalChaptersHint = null, chapterCount = 0 } = {}) {
  const vet = map => vetSourceMap(map, { chapterCount, totalVolumesHint, totalChaptersHint });
  const merged = new Map();
  const volumeTitles = new Map();
  const reports = [];

  const apply = (map, source) => {
    for (const [ch, vol] of map) merged.set(key(ch), { volume: String(vol), source });
  };

  // MangaUpdates releases (existing precedence over MangaDex).
  if (isProviderEnabled('mangaupdates') && mangaUpdatesRef?.seriesId) {
    try {
      const { map: raw, checked, verified, rejected } = await muFetchChapterVolumeMap(mangaUpdatesRef.seriesId, mangaUpdatesRef.seriesTitle || seriesTitle);
      const v = vet(raw);
      const base = { name: 'MangaUpdates', role: 'per-chapter release map', releasesChecked: checked, releasesVerified: verified, releasesRejectedMismatch: rejected };
      if (v.ok) {
        apply(v.map, 'mangaupdates');
        reports.push({ ...base, mapped: v.map.size, ...(v.dropped ? { entriesDropped: v.dropped } : {}) });
      } else {
        reports.push({ ...base, mapped: 0, rejectedAsImplausible: raw?.size > 0, rejectionReason: v.reason, ...(v.dropped ? { entriesDropped: v.dropped } : {}) });
      }
    } catch { reports.push({ name: 'MangaUpdates', role: 'per-chapter release map', error: 'lookup failed' }); }
  }

  // Fandom per-volume chapter list.
  if (isProviderEnabled('fandom')) {
    try {
      const r = await fandom.fetchChapterVolumeMap?.(seriesTitle);
      const v = r ? vet(r.map) : null;
      if (v?.ok) {
        apply(v.map, 'fandom');
        for (const [vol, t] of r.volumeTitles || []) if (!volumeTitles.has(vol)) volumeTitles.set(vol, t);
        reports.push({ name: 'Fandom Wiki', role: 'per-chapter volume list', mapped: v.map.size, matchedTitle: r.matchedTitle, sourceUrl: r.sourceUrl, ...(v.dropped ? { entriesDropped: v.dropped } : {}) });
      } else if (r) {
        // "no usable entries" is a parse that found nothing, not a map we judged
        // and threw out — say which, so the preview isn't misleading.
        reports.push({ name: 'Fandom Wiki', role: 'per-chapter volume list', mapped: 0, rejectedAsImplausible: v.reason !== 'empty', rejectionReason: v.reason, matchedTitle: r.matchedTitle });
      }
    } catch { reports.push({ name: 'Fandom Wiki', role: 'per-chapter volume list', error: 'lookup failed' }); }
  }

  // Wikipedia chapter list (highest priority — physical volume boundaries).
  if (isProviderEnabled('wikipedia')) {
    try {
      const r = await wikipedia.fetchChapterVolumeMap?.(seriesTitle);
      const v = r ? vet(r.map) : null;
      if (v?.ok) {
        apply(v.map, 'wikipedia');
        for (const [vol, t] of r.volumeTitles || []) volumeTitles.set(vol, t); // wiki titles win
        reports.push({ name: 'Wikipedia', role: 'per-chapter volume list', mapped: v.map.size, matchedTitle: r.matchedTitle, sourceUrl: r.sourceUrl, lang: r.lang, ...(r.pages?.length > 1 ? { mergedPages: r.pages.length } : {}), ...(v.dropped ? { entriesDropped: v.dropped } : {}) });
      } else if (r) {
        reports.push({ name: 'Wikipedia', role: 'per-chapter volume list', mapped: 0, rejectedAsImplausible: v.reason !== 'empty', rejectionReason: v.reason, matchedTitle: r.matchedTitle, lang: r.lang });
      }
    } catch { reports.push({ name: 'Wikipedia', role: 'per-chapter volume list', error: 'lookup failed' }); }
  }

  return { map: merged, volumeTitles, reports };
}

/**
 * @param {string} seriesTitle
 * @param {Array<{number:string, volume?:string|null}>} mangadexChapters
 * @param {{
 *   mangaUpdatesRef?:{seriesId:any,seriesTitle?:string}|null,
 *   totalVolumesHint?:number|null,
 *   totalChaptersHint?:number|null,
 *   cachedExternal?:{map:Map,volumeTitles:Map,reports:Array<object>}|null,
 * }} [opts]
 * @returns {Promise<{
 *   map: Map<string,{volume:string, source:string}>,
 *   volumeTitles: Map<string,string>,
 *   counts: Record<string,number>,      // chapters finally attributed to each source
 *   sources: string[],                  // sources that contributed at least one anchor
 *   reports: Array<object>,             // per-source detail for the refresh preview
 *   external: {map:Map,volumeTitles:Map,reports:Array<object>}, // the cacheable piece
 *   externalFromCache: boolean,         // true when `cachedExternal` was reused (nothing new to persist)
 * }>}
 */
export async function resolveChapterVolumeMap(seriesTitle, mangadexChapters, { mangaUpdatesRef = null, totalVolumesHint = null, totalChaptersHint = null, cachedExternal = null } = {}) {
  const merged = new Map();          // ch -> { volume, source }

  // 1. MangaDex tags (baseline, lowest priority) — always fresh, never cached.
  let mdApplied = 0;
  for (const c of mangadexChapters) {
    if (c.volume != null && c.volume !== '') { merged.set(key(c.number), { volume: String(c.volume), source: 'mangadex' }); mdApplied++; }
  }
  const mdReport = { name: 'MangaDex', role: 'per-chapter volume tags (baseline)', tagged: mdApplied };

  const externalFromCache = !!cachedExternal;
  const external = cachedExternal || await fetchExternalChapterSources(seriesTitle, {
    mangaUpdatesRef, totalVolumesHint, totalChaptersHint, chapterCount: mangadexChapters.length,
  });

  // 2. Overlay every external anchor over the MangaDex baseline. Correct
  // regardless of *which* external sources contributed, because
  // fetchExternalChapterSources() already applied mangaupdates<fandom<wikipedia
  // priority internally before returning a single merged map.
  for (const [ch, entry] of external.map) merged.set(ch, entry);

  const counts = {};
  for (const { source } of merged.values()) counts[source] = (counts[source] || 0) + 1;
  return {
    map: merged,
    volumeTitles: external.volumeTitles,
    counts,
    sources: Object.keys(counts),
    reports: [mdReport, ...external.reports],
    external,
    externalFromCache,
  };
}

// --- Cache (de)serialization -------------------------------------------------
// The cache lives as an opaque JSON blob on series.chapter_map_cache_json (see
// repo.js's `chapterMapCache` patch column). Every read fails closed: a
// missing/corrupt/stale blob is treated as "no cache", never a thrown error.

/** Wrap a freshly-fetched external result for persistence via updateSeries(). */
export function serializeExternalCache(external) {
  return {
    fetchedAt: Date.now(),
    map: [...external.map.entries()],
    volumeTitles: [...external.volumeTitles.entries()],
    reports: external.reports,
  };
}

/**
 * Read a still-fresh cached external result off a series row, or null if
 * there is none / it's malformed / it's past `ttlMs`.
 */
export function readCachedExternal(series, ttlMs) {
  if (!series?.chapter_map_cache_json) return null;
  let obj;
  try { obj = JSON.parse(series.chapter_map_cache_json); } catch { return null; }
  if (!obj || typeof obj.fetchedAt !== 'number') return null;
  if (Date.now() - obj.fetchedAt >= ttlMs) return null;
  return {
    map: new Map(Array.isArray(obj.map) ? obj.map : []),
    volumeTitles: new Map(Array.isArray(obj.volumeTitles) ? obj.volumeTitles : []),
    reports: Array.isArray(obj.reports) ? obj.reports : [],
  };
}

/**
 * Best-effort localized volume title for ComicInfo packaging (binder.js). Not
 * TTL-gated — a volume's title doesn't go stale the way a chapter map does, so
 * even a cache entry past its refresh window is still worth using here rather
 * than falling back to the generic auto-title. Fails closed to ''.
 */
export function getVolumeTitle(series, volumeLabel) {
  if (!series?.chapter_map_cache_json || volumeLabel == null || volumeLabel === '') return '';
  try {
    const obj = JSON.parse(series.chapter_map_cache_json);
    const entries = Array.isArray(obj?.volumeTitles) ? obj.volumeTitles : [];
    const hit = entries.find(([v]) => v === String(parseFloat(volumeLabel)));
    return hit ? hit[1] : '';
  } catch { return ''; }
}
