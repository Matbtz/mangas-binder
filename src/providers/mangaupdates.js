import { normTitle } from '../core/text-match.js';

const BASE_URL = 'https://api.mangaupdates.com/v1';

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`MangaUpdates API error ${res.status}: ${url}`);
  return res.json();
}

/**
 * Fetch the chapter→volume mapping for a series via the MangaUpdates releases
 * endpoint.  Each release record carries both `chapter` and `volume` fields,
 * giving us precise official volume boundaries that the MangaDex aggregate often
 * lacks for English simulpub series (e.g. Dandadan, One Piece).
 *
 * ROOT CAUSE (found by empirically probing the live API, not guessing): none
 * of `series_id`, `series: [id]`, `series: { id }` — or in fact any unknown
 * field name at all — has any effect on `/v1/releases/search`. Every one of
 * those bodies returns the exact same 10,000-record, most-recent-first feed
 * regardless of which series (or garbage) is sent, which is exactly the
 * cross-series contamination bug this whole saga started with (three
 * unrelated series all got the identical override). The endpoint has no
 * server-side series-id filter at all — there is nothing to guess correctly.
 *
 * The one parameter that *does* narrow results is a free-text `search`
 * (title) query: confirmed live against Dandadan (10,000 unrelated records ->
 * 247, all titled "Dandadan") and One Piece (results stayed 100% on-title
 * through ~23 pages of 100 before degrading into unrelated title-word
 * matches, e.g. "One Hundred Storey Tower", "The 31st Piece Turns the
 * Tables" — MangaUpdates tokenizes on words rather than matching the full
 * phrase, so it's a relevance pre-filter, not an exact scope). `stype` was
 * confirmed to have no observable effect (title vs author vs garbage all
 * returned identical results for the same `search` text), so it's sent for
 * documentation purposes only.
 *
 * Because that pre-filter is fuzzy, per-record verification below is still
 * required — and it is now the *only* verification, not defense-in-depth:
 * every real record sampled live (Dandadan/One Piece/Death Note, ~1,500
 * records) had no `series_id`/`series` field whatsoever, just a bare `title`
 * string. The id-matching branch is kept only in case the API ever adds that
 * field back. Verification also had to be tightened from the shared
 * `titlesMatch()`'s startsWith-based fuzzy fallback (used elsewhere for
 * genuinely looser matching) to strict normalized-title equality: real
 * "Death Note" search results included ~100 "Death Note dj - <name>"
 * fan-doujinshi entries, and `titlesMatch('Death Note dj - Light Note',
 * 'Death Note')` returns true, because the normalized doujinshi title starts
 * with the normalized target title. Since every real series record observed
 * carried the canonical title verbatim (never abbreviated or prefixed),
 * strict equality loses nothing here while closing that false-positive path.
 *
 * Returns { map, checked, verified, rejected }: map is
 * chapterNumber(string) → volumeNumber(string); the counters describe how
 * many release records were inspected/trusted/discarded so a misbehaving
 * endpoint is visible (e.g. in the refresh-preview report) instead of silent.
 *
 * Pagination: since `search` is a real (if fuzzy) pre-filter instead of a
 * no-op, most series resolve in a handful of pages rather than the old
 * 100-page firehose. The cap is raised to cover long-running series (One
 * Piece's on-title results ran ~23 pages of 100) while the early bail-out
 * after a couple of fully-unverified pages still protects against paging
 * into the tail of title-word noise once real matches run out.
 */
export async function fetchChapterVolumeMap(seriesId, expectedTitle = null) {
  const map = new Map();
  // The only param that meaningfully narrows /releases/search is a title
  // text query (see root-cause note above) — without a title there is
  // nothing to search for, and falling back to an id-only request would just
  // re-trigger the unfiltered 10,000-record firehose.
  if (!expectedTitle) return { map, checked: 0, verified: 0, rejected: 0 };

  const perPage = 100;
  const maxPages = 30;
  const maxConsecutiveEmptyPages = 2;
  const expectedNorm = normTitle(expectedTitle);
  let page = 1;
  let hasMore = true;
  let checked = 0, verified = 0, rejected = 0, consecutiveEmptyPages = 0;

  while (hasMore && page <= maxPages) {
    const data = await apiFetch(`${BASE_URL}/releases/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: expectedTitle, stype: 'title', perpage: perPage, page }),
    });

    const results = data.results || [];
    const verifiedBeforePage = verified;
    for (const r of results) {
      const rec = r.record || {};
      checked++;

      // Never assume the request-side filter actually worked — only trust a
      // record once we can positively confirm it's for *this* series, via
      // whichever series-identifying field the response happens to include.
      const recSeriesId = rec.series_id ?? rec.series?.id ?? rec.series?.series_id ?? null;
      const recSeriesTitle = rec.series_name ?? rec.series?.name ?? rec.title ?? null;
      const idMatches = recSeriesId != null && Number(recSeriesId) === Number(seriesId);
      const titleMatches = !idMatches && !!recSeriesTitle && normTitle(recSeriesTitle) === expectedNorm;
      if (!idMatches && !titleMatches) { rejected++; continue; }
      verified++;

      const ch = rec.chapter ? String(parseFloat(rec.chapter)) : null;
      const vol = rec.volume ? String(parseFloat(rec.volume)) : null;
      if (ch && vol && !Number.isNaN(parseFloat(ch)) && !Number.isNaN(parseFloat(vol))) {
        if (!map.has(ch)) map.set(ch, vol); // first/earliest entry wins
      }
    }

    consecutiveEmptyPages = verified === verifiedBeforePage ? consecutiveEmptyPages + 1 : 0;
    hasMore = results.length === perPage && consecutiveEmptyPages < maxConsecutiveEmptyPages;
    page++;
    if (hasMore) await new Promise(r => setTimeout(r, 200));
  }

  return { map, checked, verified, rejected };
}

export async function searchMangaUpdates(title) {
  const data = await apiFetch(`${BASE_URL}/series/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: title, perpage: 5 }),
  });
  return (data.results || []).map(r => ({
    id: r.record.series_id,
    title: r.record.title,
    url: r.record.url,
  }));
}

/**
 * Returns the total number of volumes from MangaUpdates status field.
 * Status examples: "24 Volumes (Ongoing)", "12 Volumes (Complete)"
 * Returns null if the count cannot be parsed.
 */
export async function fetchSeriesMetadata(seriesId) {
  const data = await apiFetch(`${BASE_URL}/series/${seriesId}`);
  const status = data.status || '';
  const match = status.match(/^(\d+)\s+Volumes?/i);
  const totalVolumes = match ? parseInt(match[1], 10) : null;
  const latestChapter = data.latest_chapter ? parseInt(data.latest_chapter, 10) : null;
  return { totalVolumes, latestChapter };
}

export async function fetchTotalVolumes(seriesId) {
  const meta = await fetchSeriesMetadata(seriesId);
  return meta.totalVolumes;
}

/**
 * Convenience: search + fetch metadata for a title.
 * Returns { totalVolumes, latestChapter, seriesTitle, seriesId } or null if not found.
 */
export async function getTotalVolumesForTitle(title) {
  let results;
  try {
    results = await searchMangaUpdates(title);
  } catch {
    return null;
  }
  if (!results.length) return null;

  const best = results.find(r => r.title.toLowerCase() === title.toLowerCase()) || results[0];

  try {
    const meta = await fetchSeriesMetadata(best.id);
    return { totalVolumes: meta.totalVolumes, latestChapter: meta.latestChapter, seriesTitle: best.title, seriesId: best.id };
  } catch {
    return null;
  }
}

/** Lightweight reachability check for the Settings "Test connection" button. */
export async function testConnection() {
  await apiFetch(`${BASE_URL}/series/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: 'naruto', perpage: 1 }),
  });
  return { message: 'Reached MangaUpdates.' };
}

/**
 * Metadata-only provider conforming to providers/base.js.
 * Supplies the total-volume hint that feeds core/extrapolate.js; it cannot
 * download pages, so it is never selected as a download source.
 */
export const provider = {
  name: 'mangaupdates',
  label: 'MangaUpdates',
  capabilities: { download: false, metadata: true },
  search: searchMangaUpdates,
  getTotalVolumesForTitle,
  testConnection,
};
