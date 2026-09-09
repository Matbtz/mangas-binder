import { titlesMatch } from '../core/text-match.js';

/**
 * MangaBaka cross-check for a series' total volume/chapter counts — a free,
 * no-auth REST API that itself aggregates AniList/MyAnimeList/MangaUpdates
 * and other sources.
 *
 * Confirmed live: unlike AniList (which only reports totals once a series is
 * finished), MangaBaka's `total_chapters`/`final_volume` stay populated and
 * closely track the source sites even for *ongoing* series (e.g. live-tested
 * One Piece: 115 volumes / 1186 chapters, matching MangaUpdates' own numbers
 * exactly) — so it's a useful independent cross-check across the whole
 * lifecycle of a series, not just completed ones.
 */

const BASE_URL = 'https://api.mangabaka.dev/v1';
const HEADERS = { 'User-Agent': 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)' };

/**
 * A transient failure must not be swallowed into "no such series".
 *
 * Live-confirmed: MangaBaka's search endpoint answers HTTP 500 for `q=Bleach`
 * (while other titles work), and because every error used to be caught and
 * turned into an empty result, the refresh preview reported it as "no verified
 * match found" — indistinguishable from MangaBaka genuinely not having the
 * series. That mattered: MangaBaka was the one provider positioned to outvote
 * MangaUpdates' wrong 250-chapter count for Bleach, and its silent absence let
 * that number win unopposed at "100% confidence". Retry a couple of times, then
 * let the error propagate so core/volume-consensus.js can label it a failed
 * lookup instead of an abstention.
 */
async function apiFetch(url, attempt = 1) {
  const maxAttempts = 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: controller.signal });
  } catch (err) {
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, attempt * 400));
      return apiFetch(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, attempt * 400));
      return apiFetch(url, attempt + 1);
    }
    throw new Error(`MangaBaka API error ${res.status}: ${url}`);
  }
  return res.json();
}

async function searchSeries(title) {
  const data = await apiFetch(`${BASE_URL}/series/search?q=${encodeURIComponent(title)}`);
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Returns { matchedTitle, totalVolumes, totalChapters, status } or null if no
 * verified match was found. Throws when the lookup itself failed — see apiFetch.
 */
export async function fetchVolumeInfo(title) {
  const results = await searchSeries(title);
  if (!results.length) return null;

  const best = results.find(r => titlesMatch(r.title, title)) || null;
  if (!best) return null; // can't verify — fail closed

  const detail = await apiFetch(`${BASE_URL}/series/${best.id}`);
  const d = detail?.data;
  if (!d) return null;

  const totalVolumes = d.final_volume != null ? parseInt(d.final_volume, 10) : null;
  const totalChapters = d.total_chapters != null ? parseInt(d.total_chapters, 10) : null;
  if (Number.isNaN(totalVolumes) && Number.isNaN(totalChapters)) return null;

  return {
    matchedTitle: d.title || best.title,
    totalVolumes: Number.isNaN(totalVolumes) ? null : totalVolumes,
    totalChapters: Number.isNaN(totalChapters) ? null : totalChapters,
    status: d.status ?? null,
  };
}

/** Lightweight reachability check for the Settings "Test connection" button. */
export async function testConnection() {
  const res = await fetchVolumeInfo('One Piece');
  if (!res) return { message: 'Reached MangaBaka, but could not verify a matching entry for the test title ("One Piece").' };
  return { message: `Reached MangaBaka: matched "${res.matchedTitle}" (status: ${res.status}).` };
}

/**
 * Metadata-only, informational provider — total-volume/chapter cross-check
 * only, same role as MangaUpdates' total-count hint. Never selected as a
 * download source.
 */
export const provider = {
  name: 'mangabaka',
  label: 'MangaBaka',
  capabilities: { download: false, metadata: false },
  fetchVolumeInfo,
  testConnection,
};
