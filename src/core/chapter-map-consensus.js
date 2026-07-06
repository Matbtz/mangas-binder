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
 */

const key = (n) => String(parseFloat(n));

/** True when a whole source map is safe to trust against the known bounds. */
function mapIsPlausible(map, chapterCount, totalVolumesHint) {
  if (!map || map.size === 0) return false;
  let maxVol = 0, maxCh = 0;
  for (const [ch, vol] of map) {
    const vn = parseFloat(vol); if (Number.isFinite(vn) && vn > maxVol) maxVol = vn;
    const cn = parseFloat(ch); if (Number.isFinite(cn) && cn > maxCh) maxCh = cn;
  }
  if (maxVol <= 0) return false;
  // A volume number well beyond a confident total is a mis-parse/wrong-edition.
  if (totalVolumesHint > 0 && maxVol > Math.floor(totalVolumesHint) * 1.5 + 1) return false;
  // Highest volume vs highest chapter must imply a sane chapters-per-volume —
  // catches a mis-parsed table (e.g. chapter 100 tagged "volume 2", or a page
  // whose numbers were read as volumes) before it can seed wrong anchors.
  if (impliesImpossibleChaptersPerVolume(maxVol, Math.max(maxCh, chapterCount))) return false;
  return true;
}

/**
 * @param {string} seriesTitle
 * @param {Array<{number:string, volume?:string|null}>} mangadexChapters
 * @param {{ mangaUpdatesRef?:{seriesId:any,seriesTitle?:string}|null, totalVolumesHint?:number|null }} [opts]
 * @returns {Promise<{
 *   map: Map<string,{volume:string, source:string}>,
 *   volumeTitles: Map<string,string>,
 *   counts: Record<string,number>,      // chapters finally attributed to each source
 *   sources: string[],                  // sources that contributed at least one anchor
 *   reports: Array<object>,             // per-source detail for the refresh preview
 * }>}
 */
export async function resolveChapterVolumeMap(seriesTitle, mangadexChapters, { mangaUpdatesRef = null, totalVolumesHint = null } = {}) {
  const merged = new Map();          // ch -> { volume, source }
  const volumeTitles = new Map();
  const reports = [];
  const chapterCount = mangadexChapters.length;

  const apply = (map, source) => {
    let applied = 0;
    for (const [ch, vol] of map) {
      const k = key(ch), v = String(vol);
      merged.set(k, { volume: v, source });
      applied++;
    }
    return applied;
  };

  // 1. MangaDex tags (baseline, lowest priority).
  let mdApplied = 0;
  for (const c of mangadexChapters) {
    if (c.volume != null && c.volume !== '') { merged.set(key(c.number), { volume: String(c.volume), source: 'mangadex' }); mdApplied++; }
  }
  reports.push({ name: 'MangaDex', role: 'per-chapter volume tags (baseline)', tagged: mdApplied });

  // 2. MangaUpdates releases (existing precedence over MangaDex).
  if (isProviderEnabled('mangaupdates') && mangaUpdatesRef?.seriesId) {
    try {
      const { map, checked, verified, rejected } = await muFetchChapterVolumeMap(mangaUpdatesRef.seriesId, mangaUpdatesRef.seriesTitle || seriesTitle);
      if (mapIsPlausible(map, chapterCount, totalVolumesHint)) {
        apply(map, 'mangaupdates');
        reports.push({ name: 'MangaUpdates', role: 'per-chapter release map', mapped: map.size, releasesChecked: checked, releasesVerified: verified, releasesRejectedMismatch: rejected });
      } else {
        reports.push({ name: 'MangaUpdates', role: 'per-chapter release map', mapped: 0, rejectedAsImplausible: map?.size > 0, releasesChecked: checked, releasesVerified: verified, releasesRejectedMismatch: rejected });
      }
    } catch { reports.push({ name: 'MangaUpdates', role: 'per-chapter release map', error: 'lookup failed' }); }
  }

  // 3. Fandom per-volume chapter list.
  if (isProviderEnabled('fandom')) {
    try {
      const r = await fandom.fetchChapterVolumeMap?.(seriesTitle);
      if (r && mapIsPlausible(r.map, chapterCount, totalVolumesHint)) {
        apply(r.map, 'fandom');
        for (const [v, t] of r.volumeTitles || []) if (!volumeTitles.has(v)) volumeTitles.set(v, t);
        reports.push({ name: 'Fandom Wiki', role: 'per-chapter volume list', mapped: r.map.size, matchedTitle: r.matchedTitle, sourceUrl: r.sourceUrl });
      } else if (r) {
        reports.push({ name: 'Fandom Wiki', role: 'per-chapter volume list', mapped: 0, rejectedAsImplausible: true, matchedTitle: r.matchedTitle });
      }
    } catch { reports.push({ name: 'Fandom Wiki', role: 'per-chapter volume list', error: 'lookup failed' }); }
  }

  // 4. Wikipedia chapter list (highest priority — physical volume boundaries).
  if (isProviderEnabled('wikipedia')) {
    try {
      const r = await wikipedia.fetchChapterVolumeMap?.(seriesTitle);
      if (r && mapIsPlausible(r.map, chapterCount, totalVolumesHint)) {
        apply(r.map, 'wikipedia');
        for (const [v, t] of r.volumeTitles || []) volumeTitles.set(v, t); // wiki titles win
        reports.push({ name: 'Wikipedia', role: 'per-chapter volume list', mapped: r.map.size, matchedTitle: r.matchedTitle, sourceUrl: r.sourceUrl, lang: r.lang });
      } else if (r) {
        reports.push({ name: 'Wikipedia', role: 'per-chapter volume list', mapped: 0, rejectedAsImplausible: true, matchedTitle: r.matchedTitle, lang: r.lang });
      }
    } catch { reports.push({ name: 'Wikipedia', role: 'per-chapter volume list', error: 'lookup failed' }); }
  }

  const counts = {};
  for (const { source } of merged.values()) counts[source] = (counts[source] || 0) + 1;
  return { map: merged, volumeTitles, counts, sources: Object.keys(counts), reports };
}
