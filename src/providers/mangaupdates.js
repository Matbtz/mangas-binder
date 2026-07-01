import { titlesMatch } from '../core/text-match.js';

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
 * IMPORTANT: this endpoint has been observed in production to *not* reliably
 * filter by the series-id filter we send — three unrelated series (Sakamoto
 * Days, One Piece, Dandadan) all got an identical "chapter 10 -> vol 3 /
 * chapter 54 -> vol 2 / chapter 69 -> vol 3" override, which is only possible
 * if the request-side filter was ignored and some generic/most-recent release
 * feed came back instead. So every record is independently verified against
 * the series id or title before being trusted, regardless of whether the
 * request filter worked — anything that can't be verified is dropped rather
 * than risking cross-series contamination of another series' volume data.
 *
 * Returns { map, checked, verified, rejected }: map is
 * chapterNumber(string) → volumeNumber(string); the counters describe how
 * many release records were inspected/trusted/discarded so a misbehaving
 * endpoint is visible (e.g. in the refresh-preview report) instead of silent.
 *
 * Confirmed in production: because the series filter is ignored, this comes
 * back as a firehose of mostly-unrelated releases (one real refresh checked
 * 10,000 records for 6 verified matches, taking over two minutes — the whole
 * refresh looked "stuck" from the UI). Paginating deep into a feed we already
 * know isn't scoped to this series has a terrible cost/benefit ratio, so this
 * now caps hard at a handful of pages *and* bails out as soon as a couple of
 * consecutive pages verify nothing, instead of exhausting the old 100-page
 * ceiling on every single refresh.
 */
export async function fetchChapterVolumeMap(seriesId, expectedTitle = null) {
  const map = new Map();
  const perPage = 100;
  const maxPages = 5;
  const maxConsecutiveEmptyPages = 2;
  let page = 1;
  let hasMore = true;
  let checked = 0, verified = 0, rejected = 0, consecutiveEmptyPages = 0;

  while (hasMore && page <= maxPages) {
    const data = await apiFetch(`${BASE_URL}/releases/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ series: [Number(seriesId)], perpage: perPage, page }),
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
      const titleMatches = !idMatches && !!expectedTitle && !!recSeriesTitle && titlesMatch(recSeriesTitle, expectedTitle);
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
