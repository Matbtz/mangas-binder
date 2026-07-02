import { titlesMatch } from '../core/text-match.js';

/**
 * AniList cross-check for a series' total volume/chapter counts — a free,
 * no-auth GraphQL API, independent of MangaUpdates and Fandom.
 *
 * Confirmed live: for series still being published, AniList (correctly)
 * returns `volumes`/`chapters` as null rather than guessing — it only reports
 * a total once the work is actually finished. That makes it most useful as a
 * cross-check for *completed* series, exactly the case where MangaUpdates'
 * own `latest_chapter` field has been observed to go stale (see
 * providers/mangaupdates.js and core/volume-consensus.js): a live query for
 * "20th Century Boys" returns {volumes: 22, chapters: 249, status:
 * "FINISHED"}, correctly matching Fandom's independently-derived numbers,
 * while MangaUpdates' own latest_chapter for that title is stuck at 13.
 */

const ENDPOINT = 'https://graphql.anilist.co';

const SEARCH_QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA) {
    title { romaji english }
    volumes
    chapters
    status
  }
}
`;

async function apiFetch(query, variables) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`AniList API error ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns { matchedTitle, totalVolumes, totalChapters, status } or null if no
 * verified match was found. totalVolumes/totalChapters are null for
 * still-publishing series (AniList's own semantics, not a lookup failure).
 */
export async function fetchVolumeInfo(title) {
  let data;
  try {
    data = await apiFetch(SEARCH_QUERY, { search: title });
  } catch { return null; }

  const media = data?.data?.Media;
  if (!media) return null;
  const romaji = media.title?.romaji || '';
  const english = media.title?.english || '';
  if (!titlesMatch(romaji, title) && !titlesMatch(english, title)) return null; // can't verify — fail closed

  return {
    matchedTitle: english || romaji,
    totalVolumes: media.volumes ?? null,
    totalChapters: media.chapters ?? null,
    status: media.status ?? null,
  };
}

/** Lightweight reachability check for the Settings "Test connection" button. */
export async function testConnection() {
  const res = await fetchVolumeInfo('One Piece');
  if (!res) return { message: 'Reached AniList, but could not verify a matching entry for the test title ("One Piece").' };
  return { message: `Reached AniList: matched "${res.matchedTitle}" (status: ${res.status}).` };
}

/**
 * Metadata-only, informational provider — total-volume/chapter cross-check
 * only, same role as MangaUpdates' total-count hint. Never selected as a
 * download source.
 */
export const provider = {
  name: 'anilist',
  label: 'AniList',
  capabilities: { download: false, metadata: false },
  fetchVolumeInfo,
  testConnection,
};
