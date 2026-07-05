import { titlesMatch } from '../core/text-match.js';

/**
 * Best-effort cross-check of a series' total volume/chapter counts against its
 * Fandom wiki infobox — a third, independent source alongside MangaUpdates.
 *
 * This is intentionally informational only: unlike MangaUpdates, its result is
 * never used to auto-set total_volumes_hint or override any chapter's volume.
 * Fandom wikis vary widely in markup per franchise, so it's surfaced purely as
 * a cross-check in the refresh-preview report for a human to compare — never
 * as an authoritative write. Disabled by default; every step fails closed
 * (returns null) rather than guessing on an unexpected response shape.
 *
 * WIKI DISCOVERY: `findWiki()` first tries Fandom's own cross-wiki search API
 * (`www.fandom.com/api/v1/Search/List`), which is the "correct"/general way to
 * resolve an arbitrary title to a wiki subdomain. Confirmed live, though, that
 * this endpoint sits behind Cloudflare bot management and returns a 403
 * challenge page to plain server-side requests from at least some hosting
 * environments — making it unconditionally useless there regardless of the
 * series. Individual wikis' own MediaWiki API on their subdomain (e.g.
 * `onepiece.fandom.com/api.php`) is not gated the same way, so when the
 * cross-search comes back empty, `findWikiBySlug()` guesses the subdomain
 * directly from the title (Fandom wikis are created with either a
 * concatenated or hyphenated slug of their name — confirmed live: "One Piece"
 * -> onepiece.fandom.com, but "Sakamoto Days" -> sakamoto-days.fandom.com, no
 * single convention covers both) and verifies the guess against the wiki's
 * own `siteinfo` sitename before trusting it, so an unverified guess is never
 * returned even if some other, unrelated wiki happens to occupy that slug.
 *
 * PAGE SELECTION: `fetchVolumeInfo()` tries the literal title and a
 * "<title> (Manga)" variant directly before falling back to the wiki's fuzzy
 * search. Confirmed live this matters: on more than one wiki, the fuzzy
 * search for the series' own name ranks a near-empty "<Title> Wiki" landing
 * page above the actual informative article (e.g. Sakamoto Days' wiki search
 * for "Sakamoto Days" returns the 27-word landing page first, while the real
 * infobox lives on "Sakamoto Days (Manga)"; 20th Century Boys' wiki doesn't
 * surface its own title page in the top-5 search results at all, despite the
 * page existing). Direct title lookups sidestep search ranking entirely; the
 * fuzzy-search path remains the last-resort fallback for wikis that don't use
 * either convention, still requiring the found title to verify against the
 * series title via `titlesMatch()` before it's trusted.
 *
 * COUNT EXTRACTION: `parseInfoboxCounts()` first tries the structured
 * `{{Infobox ... |volumes=N|chapters=N}}` pattern most actively-maintained
 * wikis use, then falls back to a narrow, lead-section-only prose pattern
 * ("... a total of N chapters ... in N volumes") for lower-effort/stub
 * articles that state the count in plain text instead. Known limitation, left
 * unaddressed as out of scope for a best-effort cross-check: some wikis (e.g.
 * one of the pages on the One Piece wiki) render their infobox count via a
 * live template transclusion (`{{Count|volumes}}`) rather than a literal
 * number, which no wikitext-only parse can read — that case fails closed
 * (returns null) rather than guessing, same as any other unparseable page.
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
async function findWikiBySearch(title) {
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

/** The 1-2 subdomain slugs a Fandom wiki for this title is plausibly created under. */
function slugCandidates(title) {
  const words = String(title)
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const concat = words.join('');
  const hyphen = words.join('-');
  return concat === hyphen ? [concat] : [concat, hyphen];
}

/**
 * Fallback wiki discovery for when the cross-wiki search endpoint is
 * unreachable (see module docstring). Guesses the subdomain from the title
 * and verifies it against the wiki's own `siteinfo` sitename before trusting
 * it — an unverified guess is never returned.
 */
async function findWikiBySlug(title) {
  for (const slug of slugCandidates(title)) {
    const domain = `${slug}.fandom.com`;
    let data;
    try {
      data = await apiFetch(`https://${domain}/api.php?action=query&meta=siteinfo&format=json`);
    } catch { continue; }
    const sitename = data?.query?.general?.sitename;
    if (!sitename) continue;
    const wikiName = sitename.replace(/\s*wiki\s*$/i, '').trim();
    if (titlesMatch(wikiName, title)) return { domain, wikiName: sitename };
  }
  return null;
}

async function findWiki(title) {
  return (await findWikiBySearch(title)) || (await findWikiBySlug(title));
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

/** Parse total volume/chapter counts out of a wiki page's raw wikitext. */
export function parseInfoboxCounts(wikitext) {
  if (!wikitext) return { totalVolumes: null, totalChapters: null };
  const volMatch = wikitext.match(/\|\s*(?:total[\s_]?)?volumes?\s*=\s*([0-9]+)/i);
  const chMatch = wikitext.match(/\|\s*(?:total[\s_]?)?chapters?\s*=\s*([0-9]+)/i);
  let totalVolumes = volMatch ? parseInt(volMatch[1], 10) : null;
  let totalChapters = chMatch ? parseInt(chMatch[1], 10) : null;

  // Fall back to plain-prose counts for wikis without a populated infobox
  // (confirmed live on a stub-quality article: "The manga counts a total of
  // 249 chapters initially published in 22 tankōbon volumes"). Restricted to
  // the lead section so an unrelated number mentioned deeper in the article
  // body (e.g. "compared to volume 5...") can't be mistaken for the total —
  // and deliberately requires a number to immediately follow "total of" /
  // "in"/"into", so approximate language ("over 1000 chapters") is left
  // unmatched rather than treated as an exact count.
  const lead = wikitext.slice(0, 2000);
  if (totalChapters == null) {
    const m = lead.match(/total(?:s|ed)?\s+of\s+([0-9]+)\s+chapters?/i);
    if (m) totalChapters = parseInt(m[1], 10);
  }
  if (totalVolumes == null) {
    const m = lead.match(/(?:in|into)\s+([0-9]+)\s+(?:tank[oō]bon\s+)?volumes?/i);
    if (m) totalVolumes = parseInt(m[1], 10);
  }

  return { totalVolumes, totalChapters };
}

/** Fetch a page's raw wikitext by exact title; null if missing/unreachable. */
async function fetchPageWikitext(domain, title) {
  let data;
  try {
    data = await apiFetch(`https://${domain}/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`);
  } catch { return null; }
  return data?.parse?.wikitext?.['*'] ?? (typeof data?.parse?.wikitext === 'string' ? data.parse.wikitext : null);
}

function toResult(domain, pageTitle, counts) {
  return {
    wikiUrl: `https://${domain}/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
    pageTitle,
    // Alias of pageTitle so this shares a { matchedTitle, totalVolumes,
    // totalChapters } shape with the mangabaka cross-check — without
    // it, a result citing real data would still show up as "matchedTitle:
    // null" in the refresh-preview report (a real citation gap, confirmed
    // live: Fandom found Dandadan's volume count but the report couldn't
    // say which page it came from).
    matchedTitle: pageTitle,
    totalVolumes: counts.totalVolumes,
    totalChapters: counts.totalChapters,
  };
}

/**
 * Returns { wikiUrl, pageTitle, totalVolumes, totalChapters } or null if no
 * wiki/page could be found and verified against the series title.
 */
export async function fetchVolumeInfo(title) {
  const wiki = await findWiki(title);
  if (!wiki) return null;

  // Try the likely direct titles first (see module docstring) — these are
  // self-verifying since we constructed the exact title text ourselves,
  // rather than trusting a fuzzy search match.
  for (const candidate of [title, `${title} (Manga)`]) {
    const wikitext = await fetchPageWikitext(wiki.domain, candidate);
    if (!wikitext) continue;
    const counts = parseInfoboxCounts(wikitext);
    if (counts.totalVolumes != null || counts.totalChapters != null) return toResult(wiki.domain, candidate, counts);
  }

  // Last resort: the wiki's own fuzzy search, still requiring the result to
  // verify against the series title before it's trusted.
  const pageTitle = await findPage(wiki.domain, title);
  if (!pageTitle || !titlesMatch(pageTitle, title)) return null; // can't verify — fail closed
  const wikitext = await fetchPageWikitext(wiki.domain, pageTitle);
  const counts = parseInfoboxCounts(wikitext);
  if (counts.totalVolumes == null && counts.totalChapters == null) return null;
  return toResult(wiki.domain, pageTitle, counts);
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
