import { getProviderConfig } from '../core/settings.js';

/**
 * ComicVine metadata provider — the de-facto metadata source for Western comics
 * (the "TheTVDB of comics"). It supplies *metadata only*; files are fetched by a
 * download provider (GetComics).
 *
 * ComicVine terminology vs ours:
 *   ComicVine "Volume" = a series run (e.g. "Saga (2012)")  -> our **series**
 *   ComicVine "Issue"  = a single issue (#1, #2, …)          -> our **chapter**
 * The collected-edition ("Trade Paperback") is our packaging **volume**, which
 * ComicVine does not map per-issue — so comics default to per-issue packaging and
 * fall back to estimated volumes (core/extrapolate.js) if volume packaging is used.
 *
 * Requires a free API key (https://comicvine.gamespot.com/api), stored in the
 * provider config (Settings → Sources). CV rate-limits ~200 req/resource/hour and
 * blocks generic User-Agents, so we set one and throttle paginated calls.
 */

const BASE_URL = 'https://comicvine.gamespot.com/api';
const HEADERS = { 'User-Agent': 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)' };

function apiKey() {
  const key = getProviderConfig('comicvine')?.apikey;
  if (!key) throw new Error('ComicVine API key not set — add it in Settings → Sources');
  return key;
}

function url(pathname, params = {}) {
  const u = new URL(`${BASE_URL}${pathname}`);
  u.searchParams.set('api_key', apiKey());
  u.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function cvFetch(u) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(u, { headers: HEADERS, signal: controller.signal });
    if (res.status === 420 || res.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      const retry = await fetch(u, { headers: HEADERS, signal: controller.signal });
      if (!retry.ok) throw new Error(`ComicVine API error ${retry.status}`);
      return await retry.json();
    }
    if (!res.ok) throw new Error(`ComicVine API error ${res.status}`);
    const data = await res.json();
    if (data.status_code && data.status_code !== 1) {
      throw new Error(`ComicVine: ${data.error || 'request failed'}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Search ComicVine volumes (series). Returns [{ id, title, year, publisher }]. */
export async function searchVolumes(query) {
  const data = await cvFetch(url('/search/', {
    query, resources: 'volume', limit: '10',
    field_list: 'id,name,start_year,publisher,count_of_issues',
  }));
  return (data.results || []).map(v => ({
    id: String(v.id),
    title: v.start_year ? `${v.name} (${v.start_year})` : v.name,
    year: v.start_year ? Number(v.start_year) : null,
    publisher: v.publisher?.name || null,
    issueCount: v.count_of_issues ?? null,
  }));
}

/** Volume (series) detail. */
export async function getVolume(volumeId) {
  const data = await cvFetch(url(`/volume/4050-${volumeId}/`, {
    field_list: 'id,name,start_year,publisher,description,deck,people,count_of_issues,image',
  }));
  const v = data.results || {};
  const roleHas = (p, ...roles) => {
    const r = String(p.role || '').toLowerCase();
    return roles.some(x => r.includes(x));
  };
  const people = v.people || [];
  const authors = people.filter(p => roleHas(p, 'writer')).map(p => p.name);
  const artists = people.filter(p => roleHas(p, 'artist', 'penciler', 'penciller', 'inker'))
    .map(p => p.name);

  return {
    title: v.start_year ? `${v.name} (${v.start_year})` : v.name,
    authors: [...new Set(authors)],
    artists: [...new Set(artists)],
    description: v.deck || stripHtml(v.description),
    genres: [],
    year: v.start_year ? Number(v.start_year) : null,
    status: null, // ComicVine has no reliable ongoing/completed flag
    publisher: v.publisher?.name || null,
    coverPath: v.image?.medium_url || v.image?.small_url || null,
    comicvineId: String(volumeId),
  };
}

/**
 * List every issue of a volume, ascending. Maps to our chapter shape:
 * { id, number, volume:null, title, lang, publishedAt, pages:null }.
 * `volume` is null — collected-edition grouping is left to extrapolation.
 */
export async function listIssues(volumeId, { lang = 'en' } = {}) {
  const out = [];
  const limit = 100;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const data = await cvFetch(url('/issues/', {
      filter: `volume:${volumeId}`,
      sort: 'issue_number:asc',
      field_list: 'id,issue_number,name,cover_date,store_date',
      limit: String(limit),
      offset: String(offset),
    }));
    total = data.number_of_total_results ?? 0;
    for (const it of data.results || []) {
      const number = it.issue_number;
      if (number == null || number === '') continue;
      out.push({
        id: String(it.id),
        number: String(number),
        volume: null,
        title: it.name || '',
        lang,
        publishedAt: it.store_date || it.cover_date || null,
        pages: null,
      });
    }
    offset += limit;
    if (offset < total) await new Promise(r => setTimeout(r, 500)); // be polite
  }
  return out;
}

/**
 * Reachability + API-key check for the Settings "Test connection" button.
 * Surfaces a clear message when the key is missing or rejected by ComicVine.
 */
export async function testConnection() {
  const data = await cvFetch(url('/search/', {
    query: 'batman', resources: 'volume', limit: '1', field_list: 'id,name',
  }));
  return { message: `Reached ComicVine, API key valid (${data.number_of_total_results ?? 0}+ volumes for a sample query).` };
}

/** Metadata-only provider. Downloads are handled by a download provider. */
export const provider = {
  name: 'comicvine',
  label: 'ComicVine',
  mediaType: 'comic',
  capabilities: { download: false, metadata: true },
  search: searchVolumes,
  getSeries: getVolume,
  listChapters: listIssues,
  testConnection,
};
