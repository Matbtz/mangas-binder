import { titlesMatch } from '../core/text-match.js';

/**
 * Best-effort cross-check of a series' total volume/chapter counts against its
 * Fandom wiki infobox — a third, independent source alongside MangaUpdates.
 *
 * This is intentionally informational only: unlike MangaUpdates, its result is
 * never used to auto-set total_volumes_hint or override any chapter's volume.
 * Fandom wikis vary widely in markup per franchise and this integration hasn't
 * been verified against live data (no network access in the environment this
 * was built in), so it's surfaced purely as a cross-check in the
 * refresh-preview report for a human to compare — never as an authoritative
 * write. Disabled by default; every step fails closed (returns null) rather
 * than guessing on an unexpected response shape.
 */

const HEADERS = { 'User-Agent': 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)' };

async function apiFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`Fandom API error ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function stripDomain(u) {
  return String(u || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** Cross-wiki search to find which Fandom wiki (subdomain) covers a series title. */
async function findWiki(title) {
  let data;
  try {
    data = await apiFetch(`https://www.fandom.com/api/v1/Search/List?query=${encodeURIComponent(title)}&limit=5`);
  } catch { return null; }
  const items = Array.isArray(data?.items) ? data.items : [];
  for (const item of items) {
    const domain = stripDomain(item.domain || item.url || item.hostname);
    const wikiName = item.title || item.wikiName || item.name || '';
    if (domain && titlesMatch(wikiName, title)) return { domain, wikiName };
  }
  const first = items[0];
  const domain = first && stripDomain(first.domain || first.url || first.hostname);
  return domain ? { domain, wikiName: first.title || first.wikiName || first.name || '' } : null;
}

/** Find the best-matching page title on a wiki via the standard MediaWiki search API. */
async function findPage(domain, title) {
  let data;
  try {
    data = await apiFetch(`https://${domain}/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&srlimit=5&format=json`);
  } catch { return null; }
  const results = Array.isArray(data?.query?.search) ? data.query.search : [];
  for (const r of results) {
    if (r.title && titlesMatch(r.title, title)) return r.title;
  }
  return results[0]?.title || null;
}

/** Parse total volume/chapter counts out of a wiki page's raw wikitext infobox. */
export function parseInfoboxCounts(wikitext) {
  if (!wikitext) return { totalVolumes: null, totalChapters: null };
  const volMatch = wikitext.match(/\|\s*(?:total[\s_]?)?volumes?\s*=\s*([0-9]+)/i);
  const chMatch = wikitext.match(/\|\s*(?:total[\s_]?)?chapters?\s*=\s*([0-9]+)/i);
  return {
    totalVolumes: volMatch ? parseInt(volMatch[1], 10) : null,
    totalChapters: chMatch ? parseInt(chMatch[1], 10) : null,
  };
}

/**
 * Returns { wikiUrl, pageTitle, totalVolumes, totalChapters } or null if no
 * wiki/page could be found and verified against the series title.
 */
export async function fetchVolumeInfo(title) {
  const wiki = await findWiki(title);
  if (!wiki) return null;

  const pageTitle = await findPage(wiki.domain, title);
  if (!pageTitle || !titlesMatch(pageTitle, title)) return null; // can't verify — fail closed

  let data;
  try {
    data = await apiFetch(`https://${wiki.domain}/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json`);
  } catch { return null; }
  const wikitext = data?.parse?.wikitext?.['*'] ?? (typeof data?.parse?.wikitext === 'string' ? data.parse.wikitext : null);
  const { totalVolumes, totalChapters } = parseInfoboxCounts(wikitext);
  if (totalVolumes == null && totalChapters == null) return null;

  return {
    wikiUrl: `https://${wiki.domain}/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
    pageTitle,
    totalVolumes,
    totalChapters,
  };
}

/** Lightweight reachability check for the Settings "Test connection" button. */
export async function testConnection() {
  const res = await fetchVolumeInfo('One Piece');
  if (!res) return { message: 'Reached Fandom, but could not verify a matching page for the test title ("One Piece") — this integration is best-effort and may not resolve every series.' };
  return { message: `Reached Fandom (${res.wikiUrl}): ${res.totalVolumes ?? '?'} volumes, ${res.totalChapters ?? '?'} chapters.` };
}

/**
 * Metadata-only, informational provider. Never selected as a download source
 * and never used to write series/chapter data automatically — see the module
 * docstring above.
 */
export const provider = {
  name: 'fandom',
  label: 'Fandom Wiki',
  capabilities: { download: false, metadata: false },
  fetchVolumeInfo,
  testConnection,
};
