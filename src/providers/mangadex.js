import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const BASE_URL = 'https://api.mangadex.org';
// Include all content ratings so adult-tagged manga chapters are not silently filtered
const CONTENT_RATINGS = 'contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic';

const HEADERS = { 'User-Agent': 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)' };

async function apiFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      const retry = await fetch(url, { headers: HEADERS, signal: controller.signal });
      if (!retry.ok) throw new Error(`MangaDex API error ${retry.status}: ${url}`);
      return await retry.json();
    }
    if (!res.ok) throw new Error(`MangaDex API error ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchManga(title) {
  // English is the default; French is the backup, so a French-only series is still
  // discoverable on the Add tab.
  const url = `${BASE_URL}/manga?title=${encodeURIComponent(title)}&limit=5&availableTranslatedLanguage[]=en&availableTranslatedLanguage[]=fr`;
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
  const matchUUID = String(mangaId).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const cleanId = matchUUID ? matchUUID[0] : String(mangaId).trim();
  const url = `${BASE_URL}/manga/${cleanId}?includes[]=author&includes[]=artist&includes[]=cover_art`;
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

  const coverRel = data.relationships.find(r => r.type === 'cover_art');
  const coverFile = coverRel?.attributes?.fileName;
  const coverPath = coverFile ? `https://uploads.mangadex.org/covers/${mangaId}/${coverFile}.256.jpg` : null;

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
    coverPath,
    mangadexId: mangaId,
  };
}

/**
 * List every chapter for a series in the requested language, ordered ascending.
 * Returns [{ id, number, volume|null, title, lang, publishedAt, pages }].
 * One row per chapter number (first/earliest scanlation wins).
 */
export async function listChapters(mangaId, { lang = 'en' } = {}) {
  const matchUUID = String(mangaId).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const cleanId = matchUUID ? matchUUID[0] : String(mangaId).trim();

  const limit = 500;
  let offset = 0;
  let total = Infinity;

  // Fetch authoritative Volume & Chapter TOC skeleton via /aggregate
  const aggMap = new Map(); // chNumber -> volNumber
  try {
    const agg = await apiFetch(`${BASE_URL}/manga/${cleanId}/aggregate`);
    for (const [volNum, vdata] of Object.entries(agg.volumes || {})) {
      const v = vdata.volume || volNum;
      if (v === 'none' || v == null) continue;
      for (const ch of Object.values(vdata.chapters || {})) {
        if (ch.chapter) aggMap.set(ch.chapter, String(v));
      }
    }
  } catch {}

  const candidatesByChapter = new Map();

  // Build a language filter: always request the target language; add 'en' as
  // a fallback when the target is something else (avoids a total blackout when
  // a chapter only exists in English).  The aggregate (fetched above without a
  // filter) already provides cross-language volume data for every chapter, so
  // restricting the feed to 1–2 languages is safe and dramatically reduces the
  // payload for long-running series (One Piece in every language = 20,000+ entries
  // vs ~1,100 in English only).
  // Language fallback chain: the series' own language first, then English (the
  // default), then French (the backup).  A chapter that exists only in French is
  // therefore still picked up rather than filtered out.  Scoring below keeps the
  // preference order so French is only chosen when nothing better is available.
  const langFilter = [...new Set([lang, 'en', 'fr'])]
    .map(l => `translatedLanguage[]=${encodeURIComponent(l)}`)
    .join('&');

  while (offset < total) {
    const url = `${BASE_URL}/manga/${cleanId}/feed`
      + `?order[chapter]=asc&limit=${limit}&offset=${offset}&${CONTENT_RATINGS}&${langFilter}`;
    const data = await apiFetch(url);
    total = data.total ?? 0;

    for (const ch of data.data || []) {
      const a = ch.attributes || {};
      const number = a.chapter;
      if (!number) continue;
      if (!candidatesByChapter.has(number)) {
        candidatesByChapter.set(number, []);
      }
      candidatesByChapter.get(number).push({
        id: ch.id,
        number,
        volume: a.volume || aggMap.get(number) || null,
        title: a.title || '',
        lang: a.translatedLanguage || 'en',
        publishedAt: a.publishAt || a.createdAt || null,
        pages: a.pages ?? null,
      });
    }

    offset += limit;
    if (offset < total) await new Promise(r => setTimeout(r, 300));
  }

  const out = [];
  for (const [number, candidates] of candidatesByChapter.entries()) {
    candidates.sort((a, b) => {
      // 1. Language priority
      const getLangScore = (l) => {
        if (l === lang) return 4;
        if (l === 'en') return 3;
        if (l === 'fr') return 2;
        return 1;
      };
      const scoreA = getLangScore(a.lang);
      const scoreB = getLangScore(b.lang);
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      // 2. Pages > 0 priority (avoid empty/broken chapters)
      const pagesA = a.pages || 0;
      const pagesB = b.pages || 0;
      if ((pagesA > 0) !== (pagesB > 0)) {
        return pagesA > 0 ? -1 : 1;
      }

      // 3. Keep original order
      return 0;
    });

    out.push(candidates[0]);
  }

  const seen = new Set(out.map(c => c.number));
  for (const [num, vol] of aggMap) {
    if (!seen.has(num)) {
      seen.add(num);
      out.push({
        id: `agg-${cleanId}-${num}`,
        number: num,
        volume: vol,
        title: `Chapter ${num}`,
        lang,
        publishedAt: null,
        pages: null,
      });
    }
  }

  out.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
  return out;
}

/**
 * Resolve a chapter's page image URLs via the MangaDex@Home flow.
 * GET /at-home/server/{id} -> { baseUrl, chapter: { hash, data[], dataSaver[] } }
 * Page URL = {baseUrl}/{quality}/{hash}/{filename}
 * @param {string} chapterId
 * @param {{ dataSaver?: boolean, lang?: string }} opts
 */
export async function getChapterPages(chapterId, { dataSaver = false, mangaId = null, chapterNum = null, lang = 'en' } = {}) {
  let cid = chapterId;
  const sortChapters = (list) => {
    return [...list].sort((a, b) => {
      // Series language wins, then English (default), then French (backup).
      const getLangScore = (l) => {
        if (l === lang) return 4;
        if (l === 'en') return 3;
        if (l === 'fr') return 2;
        return 1;
      };
      const scoreA = getLangScore(a.attributes?.translatedLanguage);
      const scoreB = getLangScore(b.attributes?.translatedLanguage);
      if (scoreA !== scoreB) return scoreB - scoreA;
      const pagesA = a.attributes?.pages || 0;
      const pagesB = b.attributes?.pages || 0;
      if ((pagesA > 0) !== (pagesB > 0)) return pagesA > 0 ? -1 : 1;
      return 0;
    });
  };

  if (cid && (cid.startsWith('agg-') || cid.startsWith('mu-synth-'))) {
    const parts = cid.split('-');
    let mUUID = null;
    let num = null;
    if (cid.startsWith('agg-')) {
      mUUID = parts.slice(1, -1).join('-');
      num = parts[parts.length - 1];
    } else if (mangaId) {
      mUUID = mangaId;
      num = chapterNum;
    }
    if (mUUID && num) {
      try {
        const res = await apiFetch(`${BASE_URL}/chapter?manga=${mUUID}&chapter=${num}&order[publishAt]=desc`);
        if (res?.data?.length) {
          const sorted = sortChapters(res.data);
          cid = sorted[0].id;
        }
      } catch {}
    }
  }

  let data;
  try {
    data = await apiFetch(`${BASE_URL}/at-home/server/${cid}`);
  } catch (err) {
    if (mangaId && chapterNum) {
      try {
        const res = await apiFetch(`${BASE_URL}/chapter?manga=${mangaId}&chapter=${chapterNum}&order[publishAt]=desc`);
        if (res?.data?.length) {
          const sorted = sortChapters(res.data);
          cid = sorted[0].id;
          data = await apiFetch(`${BASE_URL}/at-home/server/${cid}`);
        }
      } catch {}
    }
    if (!data) throw err;
  }

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
