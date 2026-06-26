import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const BASE_URL = 'https://api.mangadex.org';
// Include all content ratings so adult-tagged manga chapters are not silently filtered
const CONTENT_RATINGS = 'contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic';

const HEADERS = { 'User-Agent': 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)' };

async function apiFetch(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2000));
    const retry = await fetch(url, { headers: HEADERS });
    if (!retry.ok) throw new Error(`MangaDex API error ${retry.status}: ${url}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`MangaDex API error ${res.status}: ${url}`);
  return res.json();
}

export async function searchManga(title) {
  const url = `${BASE_URL}/manga?title=${encodeURIComponent(title)}&limit=5&availableTranslatedLanguage[]=en`;
  const data = await apiFetch(url);
  return (data.data || []).map(m => ({
    id: m.id,
    title: m.attributes.title.en || Object.values(m.attributes.title)[0] || m.id,
  }));
}

/**
 * Pass 1: aggregate endpoint — fast, but EN scanlations often lack volume tags.
 * Returns VolumeMap: { "1": ["1","2","3"], "none": ["103","104"] }
 */
async function fetchFromAggregate(mangaId) {
  const data = await apiFetch(`${BASE_URL}/manga/${mangaId}/aggregate`);
  const volumeMap = {};
  for (const [volKey, volData] of Object.entries(data.volumes || {})) {
    volumeMap[volKey] = Object.keys(volData.chapters || {});
  }
  return volumeMap;
}

/**
 * Pass 2: chapter feed — paginated, returns all chapters with their volume field.
 * Used to fill in gaps left by the aggregate endpoint (e.g. ongoing volumes).
 * Returns a flat map: { "103": "12", "104": "12", ... }
 */
async function fetchChapterVolumesFromFeed(mangaId, onPage) {
  const chapterToVolume = {};
  const limit = 500;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `${BASE_URL}/manga/${mangaId}/feed?order[chapter]=asc&limit=${limit}&offset=${offset}&${CONTENT_RATINGS}`;
    const data = await apiFetch(url);
    total = data.total ?? 0;

    for (const ch of data.data || []) {
      const chNum = ch.attributes?.chapter;
      const volNum = ch.attributes?.volume;
      // Only record if this chapter doesn't already have a volume assigned
      if (chNum && volNum && !chapterToVolume[chNum]) {
        chapterToVolume[chNum] = volNum;
      }
    }

    offset += limit;
    if (onPage) onPage(Math.min(offset, total), total);
    // Small delay to avoid rate limiting on paginated requests
    if (offset < total) await new Promise(r => setTimeout(r, 300));
  }

  return chapterToVolume;
}

/**
 * Returns a VolumeMap: { "1": ["1","2","3"], "2": ["4","5"], "none": ["100.5"] }
 * "none" = chapters with no volume assignment after both passes.
 * Cache is stored in outputDir to avoid repeated API calls.
 */
/** Returns { title, authors, artists, description, genres, year, mangadexId } */
export async function fetchMangaDetails(mangaId) {
  const url = `${BASE_URL}/manga/${mangaId}?includes[]=author&includes[]=artist`;
  const { data } = await apiFetch(url);
  const attrs = data.attributes;

  const authors = data.relationships
    .filter(r => r.type === 'author')
    .map(r => r.attributes?.name)
    .filter(Boolean);

  const artists = data.relationships
    .filter(r => r.type === 'artist')
    .map(r => r.attributes?.name)
    .filter(Boolean);

  const description = attrs.description?.en || Object.values(attrs.description || {})[0] || '';

  const genres = (attrs.tags || [])
    .filter(t => t.attributes.group === 'genre')
    .map(t => t.attributes.name.en || Object.values(t.attributes.name)[0]);

  return {
    title: attrs.title?.en || Object.values(attrs.title || {})[0],
    authors,
    artists,
    description,
    genres,
    year: attrs.year,
    status: attrs.status || null, // ongoing | completed | hiatus | cancelled
    mangadexId: mangaId,
  };
}

/**
 * List every chapter for a series in the requested language, ordered ascending.
 * Returns [{ id, number, volume|null, title, lang, publishedAt, pages }].
 * One row per chapter number (first/earliest scanlation wins).
 */
export async function listChapters(mangaId, { lang = 'en' } = {}) {
  const out = [];
  const seen = new Set();
  const limit = 500;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `${BASE_URL}/manga/${mangaId}/feed`
      + `?order[chapter]=asc&limit=${limit}&offset=${offset}`
      + `&translatedLanguage[]=${encodeURIComponent(lang)}&${CONTENT_RATINGS}`;
    const data = await apiFetch(url);
    total = data.total ?? 0;

    for (const ch of data.data || []) {
      const a = ch.attributes || {};
      const number = a.chapter;
      if (!number || seen.has(number)) continue;
      // Skip external chapters with no hostable pages (externalUrl + 0 pages)
      if (a.externalUrl && (a.pages ?? 0) === 0) continue;
      seen.add(number);
      out.push({
        id: ch.id,
        number,
        volume: a.volume || null,
        title: a.title || '',
        lang: a.translatedLanguage || lang,
        publishedAt: a.publishAt || a.createdAt || null,
        pages: a.pages ?? null,
      });
    }

    offset += limit;
    if (offset < total) await new Promise(r => setTimeout(r, 300));
  }

  return out;
}

/**
 * Resolve a chapter's page image URLs via the MangaDex@Home flow.
 * GET /at-home/server/{id} -> { baseUrl, chapter: { hash, data[], dataSaver[] } }
 * Page URL = {baseUrl}/{quality}/{hash}/{filename}
 * @param {string} chapterId
 * @param {{ dataSaver?: boolean }} opts
 */
export async function getChapterPages(chapterId, { dataSaver = false } = {}) {
  const data = await apiFetch(`${BASE_URL}/at-home/server/${chapterId}`);
  const baseUrl = data.baseUrl;
  const hash = data.chapter?.hash;
  const files = dataSaver ? data.chapter?.dataSaver : data.chapter?.data;
  const quality = dataSaver ? 'data-saver' : 'data';
  if (!baseUrl || !hash || !Array.isArray(files)) {
    throw new Error(`MangaDex@Home returned no pages for chapter ${chapterId}`);
  }
  return files.map(f => `${baseUrl}/${quality}/${hash}/${f}`);
}

/**
 * Returns a Map: volumeNumber(string) → coverUrl(string)
 * Uses the 512px MangaDex thumbnail. Takes the first cover per volume.
 */
export async function fetchVolumeCovers(mangaId) {
  const url = `${BASE_URL}/cover?manga[]=${mangaId}&limit=100&order[volume]=asc`;
  const data = await apiFetch(url);
  const coverMap = new Map();
  for (const cover of data.data || []) {
    const vol = cover.attributes.volume;
    if (vol && !coverMap.has(vol)) {
      const filename = cover.attributes.fileName;
      coverMap.set(vol, `https://uploads.mangadex.org/covers/${mangaId}/${filename}.512.jpg`);
    }
  }
  return coverMap;
}

export async function fetchVolumeMap(mangaId, cacheDir, forceRefresh = false) {
  const cacheFile = path.join(cacheDir, `.mangadex-${mangaId}.json`);

  if (!forceRefresh && existsSync(cacheFile)) {
    const raw = await readFile(cacheFile, 'utf-8');
    console.log(`  (mapping from cache: ${cacheFile})`);
    return JSON.parse(raw);
  }

  // Pass 1
  process.stdout.write('  Pass 1: aggregate endpoint...');
  const volumeMap = await fetchFromAggregate(mangaId);
  const noneCount = (volumeMap['none'] || []).length;
  const volCount = Object.keys(volumeMap).filter(v => v !== 'none').length;
  console.log(` ${volCount} volumes, ${noneCount} unassigned chapters`);

  // Pass 2: only if there are unassigned chapters
  if (noneCount > 0) {
    process.stdout.write('  Pass 2: chapter feed (filling gaps)...');
    const feedMap = await fetchChapterVolumesFromFeed(mangaId, (done, total) => {
      process.stdout.write(`\r  Pass 2: chapter feed (${done}/${total} chapters fetched)...`);
    });

    // Merge feed results into volumeMap
    const noneSet = new Set(volumeMap['none'] || []);
    let filled = 0;
    for (const [chNum, volNum] of Object.entries(feedMap)) {
      if (noneSet.has(chNum)) {
        // Move from 'none' to the correct volume
        noneSet.delete(chNum);
        if (!volumeMap[volNum]) volumeMap[volNum] = [];
        if (!volumeMap[volNum].includes(chNum)) volumeMap[volNum].push(chNum);
        filled++;
      }
    }
    volumeMap['none'] = [...noneSet];
    console.log(`\r  Pass 2: ${filled} additional chapters assigned to volumes.   `);
  }

  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(volumeMap, null, 2), 'utf-8');
  return volumeMap;
}

/** Lightweight reachability check for the Settings "Test connection" button. */
export async function testConnection() {
  const data = await apiFetch(`${BASE_URL}/manga?limit=1`);
  return { message: `Reached MangaDex (${data.total ?? 0} titles indexed).` };
}

/** Provider object conforming to providers/base.js. */
export const provider = {
  name: 'mangadex',
  label: 'MangaDex',
  capabilities: { download: true, metadata: true },
  search: searchManga,
  getSeries: fetchMangaDetails,
  listChapters,
  getChapterPages,
  getVolumeCovers: fetchVolumeCovers,
  testConnection,
};
