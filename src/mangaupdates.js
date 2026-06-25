const BASE_URL = 'https://api.mangaupdates.com/v1';

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`MangaUpdates API error ${res.status}: ${url}`);
  return res.json();
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
export async function fetchTotalVolumes(seriesId) {
  const data = await apiFetch(`${BASE_URL}/series/${seriesId}`);
  const status = data.status || '';
  const match = status.match(/^(\d+)\s+Volumes?/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Convenience: search + fetch total volumes for a title.
 * Returns { totalVolumes, seriesTitle, seriesId } or null if not found.
 */
export async function getTotalVolumesForTitle(title) {
  let results;
  try {
    results = await searchMangaUpdates(title);
  } catch {
    return null;
  }
  if (!results.length) return null;

  // Pick the first result with an exact (case-insensitive) title match, else first result
  const best = results.find(r => r.title.toLowerCase() === title.toLowerCase()) || results[0];

  try {
    const totalVolumes = await fetchTotalVolumes(best.id);
    return { totalVolumes, seriesTitle: best.title, seriesId: best.id };
  } catch {
    return null;
  }
}
