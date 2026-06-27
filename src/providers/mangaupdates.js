const BASE_URL = 'https://api.mangaupdates.com/v1';

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`MangaUpdates API error ${res.status}: ${url}`);
  return res.json();
}

/**
 * Fetch the chapter→volume mapping for a series via the MangaUpdates releases
 * endpoint.  Each release record carries both `chapter` and `volume` fields,
 * giving us precise official volume boundaries that the MangaDex aggregate often
 * lacks for English simulpub series (e.g. Dandadan, One Piece).
 *
 * Returns a Map: chapterNumber(string) → volumeNumber(string)
 * Only entries where both fields are valid numbers are included.
 *
 * We cap at 100 pages (10 000 releases) to avoid runaway calls on very long
 * series; in practice even One Piece fits comfortably within that limit.
 */
export async function fetchChapterVolumeMap(seriesId) {
  const map = new Map();
  const perPage = 100;
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 100) {
    const data = await apiFetch(`${BASE_URL}/releases/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ series_id: Number(seriesId), per_page: perPage, page }),
    });

    const results = data.results || [];
    for (const r of results) {
      const rec = r.record || {};
      const ch = rec.chapter ? String(parseFloat(rec.chapter)) : null;
      const vol = rec.volume ? String(parseFloat(rec.volume)) : null;
      if (ch && vol && !Number.isNaN(parseFloat(ch)) && !Number.isNaN(parseFloat(vol))) {
        if (!map.has(ch)) map.set(ch, vol); // first/earliest entry wins
      }
    }

    hasMore = results.length === perPage;
    page++;
    if (hasMore) await new Promise(r => setTimeout(r, 200));
  }

  return map;
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
