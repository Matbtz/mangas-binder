import { getProviderConfig } from '../core/settings.js';
import { fetchRetry } from '../download/limit.js';

/**
 * GetComics download provider — resolves direct-download (DDL) archive links for
 * comic issues, the same source Kapowarr uses. This is the *file* source for
 * comics; metadata comes from ComicVine.
 *
 * ⚠️ This is an HTML/DDL scraper of a third-party site. The site markup and link
 * structure change without notice, so the parsing below is deliberately isolated
 * and tolerant — when GetComics breaks, fixes live in extractDownloadLinks() and
 * parseSearchResults(). It returns a *whole archive* (CBZ/ZIP) per match; the
 * archive-downloader extracts it into the normal staging layout so the rest of
 * the pipeline (bind/package/library) is shared with manga.
 *
 * Bulk downloading from aggregator sites generally violates their ToS — this is
 * a personal-archival convenience and you own that choice.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) mangas-binder/2.0',
  'Accept': 'text/html,application/xhtml+xml',
};

/** Configurable base (GetComics has migrated domains before). */
function baseUrl() {
  return (getProviderConfig('getcomics')?.baseUrl || 'https://getcomics.org').replace(/\/+$/, '');
}

async function getHtml(u) {
  const res = await fetchRetry(u, { headers: HEADERS, retries: 2 });
  if (!res.ok) throw new Error(`GetComics HTTP ${res.status}`);
  return res.text();
}

/** Drop our "(year)" suffix and punctuation for a cleaner site query. */
function cleanTitle(title) {
  return String(title).replace(/\(\d{4}\)\s*$/, '').replace(/[:\-–]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a GetComics listing page into [{ id: postUrl, title }].
 * Listings render each result as <h1 class="post-title"><a href=…>Title</a>.
 */
export function parseSearchResults(html) {
  const out = [];
  const re = /<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (url && title) out.push({ id: url, title });
  }
  return out;
}

// GetComics routes every mirror button through the same /dls/ (older: /dlds/)
// redirector, so matching that path captures *all* mirrors regardless of their
// button label — the download-host names below only matter for a manually-pasted
// direct link that skips the redirector.
const DLS_RE = /getcomics\.org\/(?:dls|dlds)\//i;
const HOST_RE = /(fast-down|cdn|pixeldrain\.com\/api\/file|\/run\/|\.cbz|\.cbr|\.zip)/i;

/**
 * Extract candidate download links from a post page, most-reliable first.
 * GetComics renders every mirror as an <a> pointing at its /dls/ redirector
 * (labelled "DOWNLOAD NOW", "Pixeldrain", "WeTransfer", "Mediafire", …). We keep
 * ALL of them — even ones whose label we don't recognise — so the downloader can
 * fall through the whole list; a mirror we can't yet resolve simply fails its
 * attempt and the loop moves on to the next candidate.
 */
export function extractDownloadLinks(html) {
  const links = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const looksLikeDl = DLS_RE.test(href)
      || /download now|main server|mirror|fast down|pixeldrain|we ?transfer|media ?fire/.test(text)
      || HOST_RE.test(href);
    if (looksLikeDl && /^https?:\/\//.test(href)) links.push({ href, text });
  }
  links.sort((a, b) => rank(b) - rank(a));
  return [...new Map(links.map(l => [l.href, l])).values()].map(l => l.href);
}

function rank(l) {
  // Order by how cleanly and reliably we can actually pull the file, NOT by the
  // site's own "main server" preference. The "main server"/"download now" DDL
  // redirects to rotating comicfiles.ru hosts behind a Cloudflare JS challenge
  // that FlareSolverr routinely times out on (~70s of dead wait per attempt), so
  // it must sit BELOW the mirrors we resolve directly:
  //   pixeldrain — clean un-gated direct API (pixeldrain.com/api/file/{id})
  //   mediafire  — clean landing-page → download*.mediafire.com resolver
  //   main DDL   — canonical file but Cloudflare-gated (needs FlareSolverr)
  //   other      — WeTransfer (best-effort) / TeraBox / Mega / unknown mirrors
  if (/pixeldrain/.test(l.text) || /pixeldrain/.test(l.href)) return 4;
  if (/media ?fire/.test(l.text) || /mediafire/.test(l.href)) return 3;
  if (/download now|main server/.test(l.text)) return 2;
  if (DLS_RE.test(l.href) || /fast-down/.test(l.href)) return 1;
  return 0;
}

function archiveKind(url) {
  const ext = (url.split('?')[0].match(/\.(cbz|cbr|zip)$/i) || [])[1];
  return ext ? ext.toLowerCase() : 'cbz'; // assume zip-family when undetectable
}

/** Does a post title plausibly contain this issue number? */
function matchesIssue(title, number) {
  const n = parseFloat(number);
  if (Number.isNaN(n)) return true;
  const padded = String(Math.trunc(n)).padStart(3, '0');
  const re = new RegExp(`(?:#|\\b0*)${Math.trunc(n)}\\b|\\b${padded}\\b`);
  return re.test(title);
}

/** Search GetComics. Returns [{ id: postUrl, title }]. */
export async function search(query) {
  const u = `${baseUrl()}/?s=${encodeURIComponent(query)}`;
  return parseSearchResults(await getHtml(u));
}

/**
 * Resolve a downloadable archive for a single issue.
 *
 * Returns EVERY candidate mirror (ranked, pixeldrain first) as `urls`, not just
 * one, so the archive-downloader can fall back to the next when a mirror fails —
 * critical because the "main server" DDL redirects to Cloudflare-gated
 * comicfiles.ru hosts that often can't be solved, while pixeldrain works directly.
 *
 * The DDL link also rejects direct fetches with no `Referer` (same anti-hotlink
 * pattern as MangaKatana's image CDN), so we hand back the post page as
 * `headers.Referer` for the downloader to send on the actual file request.
 *
 * @param {object} series  row (title, year)
 * @param {object} chapter row (number)
 * @returns {Promise<{ urls, url, filename, kind, headers } | null>}
 */
export async function findIssueDownload(series, chapter) {
  const q = `${cleanTitle(series.title)} ${chapter.number}`;
  let results;
  if (series.externalLinks && series.externalLinks.getcomics) {
    results = [{ id: series.externalLinks.getcomics, title: q }];
  } else {
    results = await search(q);
  }
  if (!results.length) return null;

  // Prefer a post whose title contains the issue number.
  const post = results.find(r => matchesIssue(r.title, chapter.number)) || results[0];
  const urls = extractDownloadLinks(await getHtml(post.id));
  if (!urls.length) return null;

  return {
    urls,
    url: urls[0], // backward-compat: first candidate
    filename: `${cleanTitle(series.title)} ${chapter.number}.${archiveKind(urls[0])}`,
    kind: archiveKind(urls[0]),
    headers: { Referer: post.id },
  };
}

export async function resolvePostUrl(postUrl) {
  if (HOST_RE.test(postUrl) && !postUrl.includes('getcomics.org/')) {
    return { urls: [postUrl], url: postUrl, filename: `manual.${archiveKind(postUrl)}`, kind: archiveKind(postUrl), headers: { Referer: `${baseUrl()}/` } };
  }
  const html = await getHtml(postUrl);
  const urls = extractDownloadLinks(html);
  if (!urls.length) return null;
  return { urls, url: urls[0], filename: `manual.${archiveKind(urls[0])}`, kind: archiveKind(urls[0]), headers: { Referer: postUrl } };
}

/** Reachability check for the Settings "Test connection" button. */
export async function testConnection() {
  const res = await fetchRetry(`${baseUrl()}/`, { headers: HEADERS, retries: 1 });
  if (!res.ok) throw new Error(`GetComics returned HTTP ${res.status}`);
  return { message: `Reached GetComics at ${baseUrl()}.` };
}

/** Archive-download provider (returns whole CBZ/ZIP archives, not page URLs). */
export const provider = {
  name: 'getcomics',
  label: 'GetComics',
  mediaType: 'comic',
  capabilities: { download: false, archive: true, metadata: false },
  search,
  findIssueDownload,
  resolvePostUrl,
  testConnection,
};
