/**
 * Shared MediaWiki client + chapter→volume table parser, used by both the
 * Wikipedia provider and Fandom's per-chapter mapping. The report driving this
 * ("Audit Architectural … Répartition des Chapitres de Manga par Volume") calls
 * for pulling the *authoritative* physical-volume boundaries from wiki chapter
 * lists — where they exist — instead of only extrapolating from sparse provider
 * tags.
 *
 * VALIDATION: wiki markup varies per project/franchise, so every parser *fails
 * closed* — an unrecognised structure yields an empty map rather than a guess,
 * and `looksLikeChapterList()` below throws out a map the parser produced but
 * clearly misread. Validated live against the English Wikipedia: Bleach and
 * Naruto parse correctly (including their split "(1–187)" style pages), while
 * Berserk, Death Note and One Piece — whose layouts this parser reads as ISBN
 * fragments and years — are rejected rather than half-trusted.
 */

const HEADERS = { 'User-Agent': 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)' };

/** Timed fetch of a MediaWiki JSON endpoint; throws on network error / !ok. */
export async function wikiFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`Wiki API error ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Base api.php URL for a MediaWiki host. Fandom wikis serve it at
 * `https://<domain>/api.php`; Wikimedia projects at `https://<host>/w/api.php`.
 */
export function apiBase(host, apiPath = '/api.php') {
  return `https://${host}${apiPath}`;
}

/** Raw wikitext of a page by exact title; null if missing/unreachable. */
export async function fetchWikitext(base, title) {
  let data;
  try {
    data = await wikiFetch(`${base}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`);
  } catch { return null; }
  return data?.parse?.wikitext?.['*'] ?? (typeof data?.parse?.wikitext === 'string' ? data.parse.wikitext : null);
}

/** Search page titles on a wiki (MediaWiki list=search). Returns titles[]. */
export async function searchTitles(base, query, limit = 5) {
  let data;
  try {
    data = await wikiFetch(`${base}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json`);
  } catch { return []; }
  return (Array.isArray(data?.query?.search) ? data.query.search : []).map(r => r.title).filter(Boolean);
}

// --- Chapter number extraction --------------------------------------------

/**
 * No manga runs past this; a "chapter number" above it came from something that
 * isn't a chapter number at all. The case that motivated the cap: a citation on
 * "List of Bleach volumes" carried an Internet Archive URL, and its snapshot
 * stamp was read as chapter *20160610100934*. One such entry was enough to make
 * the page's whole 646-chapter map look physically impossible to
 * chapter-map-consensus.js, which threw the entire (otherwise usable) source
 * away — a single stray token silently costing us the best volume-boundary
 * source we had.
 */
const MAX_CHAPTER_NUMBER = 5000;

/**
 * Remove the parts of a wiki page that carry digits but no chapter numbers:
 * HTML comments, `<ref>…</ref>` citations (and the templates nested inside them)
 * and bare URLs. Deliberately does NOT touch `{{cite}}` templates outside a ref
 * — a non-greedy match would stop at the first `}}` of a nested template and
 * leave an unbalanced brace, breaking the template scanner below.
 */
function stripCitationNoise(wikitext) {
  return String(wikitext)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<ref[^>]*\/>/gi, ' ')
    .replace(/<ref[\s\S]*?<\/ref>/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

/**
 * Pull chapter numbers out of a free-form chapter reference, tolerating the
 * non-standard nomenclature the report flags (Blame!'s "LOG 12"/"EX-LOG",
 * decimal side-chapters "34.5"). Returns null for a pure bonus with no number
 * (e.g. a bare "EX-LOG") so the caller can skip it rather than mis-number.
 */
function chapterNumbersFromText(text) {
  const out = [];
  const s = String(text);
  // Range "12–17" / "12 à 17" / "12-17" (en dash, hyphen, French "à").
  const rangeRe = /\b(\d+)\s*(?:–|—|-|à|to)\s*(\d+)\b/g;
  let m, consumed = new Set();
  while ((m = rangeRe.exec(s))) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (b >= a && b - a < 500) { for (let i = a; i <= b; i++) out.push(String(i)); consumed.add(m.index); }
  }
  if (out.length) return [...new Set(out)].filter(isPlausibleChapterNumber);
  // Otherwise collect standalone integers/decimals ("LOG 12", "12.5", "1, 2, 3").
  const numRe = /\b(\d+(?:\.\d+)?)\b/g;
  while ((m = numRe.exec(s))) out.push(String(parseFloat(m[1])));
  return [...new Set(out)].filter(isPlausibleChapterNumber);
}

/** A parsed token can only be a chapter number if it's in a chapter's range. */
function isPlausibleChapterNumber(n) {
  const v = parseFloat(n);
  return Number.isFinite(v) && v >= 0 && v <= MAX_CHAPTER_NUMBER;
}

// --- EN Wikipedia: {{Graphic novel list}} ---------------------------------

/**
 * Split a `{{Graphic novel list ...}}` template invocation into its top-level
 * `|param=value` pairs, respecting nested `{{...}}` and `[[...]]` so a pipe
 * inside a nested template/link doesn't split a value.
 */
function templateParams(body) {
  const params = {};
  let depth = 0, buf = '', parts = [];
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; buf += two; i++; continue; }
    if (two === '}}' || two === ']]') { depth--; buf += two; i++; continue; }
    if (body[i] === '|' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += body[i];
  }
  parts.push(buf);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return params;
}

/** Extract every `{{Graphic novel list ...}}` invocation body from wikitext. */
function graphicNovelListBlocks(wikitext) {
  const blocks = [];
  const re = /\{\{\s*Graphic novel list\s*\|/gi;
  let m;
  while ((m = re.exec(wikitext))) {
    // Walk to the matching }} from just after the template name.
    let i = m.index + 2, depth = 1;
    while (i < wikitext.length && depth > 0) {
      const two = wikitext.slice(i, i + 2);
      if (two === '{{') { depth++; i += 2; continue; }
      if (two === '}}') { depth--; i += 2; continue; }
      i++;
    }
    blocks.push(wikitext.slice(m.index + 2, i - 2));
  }
  return blocks;
}

function parseGraphicNovelList(wikitext) {
  const blocks = graphicNovelListBlocks(wikitext);
  const map = new Map();
  const volumeTitles = new Map();
  let cumulative = 0;
  for (const body of blocks) {
    const p = templateParams(body.replace(/^[^|]*\|/, '|').replace(/^\|/, ''));
    const volNum = p.volumenumber != null ? parseInt(p.volumenumber, 10) : NaN;
    if (Number.isNaN(volNum)) continue;
    const vol = String(volNum);
    if (p.volumetitle) volumeTitles.set(vol, p.volumetitle.replace(/''+/g, '').trim());

    const list = p.chapterlist || '';
    // Each list item is a "#"/"*" line = one chapter, in reading order.
    const items = list.split('\n').map(l => l.trim()).filter(l => /^[#*]/.test(l));
    for (const item of items) {
      const body2 = item.replace(/^[#*\s]+/, '');
      const explicit = body2.match(/^0*(\d+(?:\.\d+)?)\s*[.:)\-–]/); // "12. Title" / "12 – Title"
      if (explicit && isPlausibleChapterNumber(explicit[1])) {
        map.set(String(parseFloat(explicit[1])), vol);
        cumulative = Math.max(cumulative, Math.floor(parseFloat(explicit[1])));
      } else {
        cumulative += 1;
        map.set(String(cumulative), vol);
      }
    }
  }
  return { map, volumeTitles };
}

// --- Generic wikitable (FR "Liste des chapitres de …", some Fandom pages) ---

/**
 * Parse a MediaWiki `{| … |}` table that has a volume column and a chapters
 * column (numbers or "N à M" ranges). Heuristic + fail-closed: only rows where
 * we can read a volume integer AND at least one chapter number contribute.
 */
function parseChapterTable(wikitext) {
  const map = new Map();
  const volumeTitles = new Map();
  const tableRe = /\{\|[\s\S]*?\|\}/g;
  let tbl;
  while ((tbl = tableRe.exec(wikitext))) {
    const rows = tbl[0].split(/\n\|-/).map(r => r.trim());
    for (const row of rows) {
      // Cells are separated by "||" on a line or one "|" per line.
      const cells = row
        .replace(/^\{\|[^\n]*\n?/, '')
        .split(/\n\|\||\n\||\|\|/)
        .map(c => c.replace(/^[|!]\s*/, '').trim())
        .filter(Boolean);
      if (cells.length < 2) continue;
      // Volume = first cell that is a bare small integer.
      const volCell = cells.find(c => /^\d{1,3}$/.test(c.replace(/[^0-9]/g, '')) && /^\D*\d{1,3}\D*$/.test(c));
      const vNum = volCell ? parseInt(volCell.replace(/[^0-9]/g, ''), 10) : NaN;
      if (Number.isNaN(vNum) || vNum <= 0) continue;
      // Chapters = the cell mentioning a range or the longest list of numbers.
      let best = [];
      for (const c of cells) {
        if (c === volCell) continue;
        const nums = chapterNumbersFromText(c);
        if (nums.length > best.length) best = nums;
      }
      if (!best.length) continue;
      for (const n of best) if (!map.has(n)) map.set(n, String(vNum));
    }
  }
  return { map, volumeTitles };
}

/**
 * Parse a wiki page's raw wikitext into a chapter→volume map. Tries the
 * templated EN "Graphic novel list" first, then a generic chapters table
 * (FR/other). Returns { map: Map<chapterNumber, volume>, volumeTitles }.
 * Empty map on anything unrecognised (fail closed).
 *
 * @param {string} wikitext
 * @param {'en'|'fr'|string} [lang]  hint only; parsing is structure-driven.
 */
export function parseChapterVolumeMap(wikitext, lang = 'en') {
  if (!wikitext) return { map: new Map(), volumeTitles: new Map() };
  const clean = stripCitationNoise(wikitext);
  const gnl = parseGraphicNovelList(clean);
  if (gnl.map.size) return gnl;
  return parseChapterTable(clean);
}

// --- Structural quality gate ------------------------------------------------

/**
 * Measure how much a parsed map actually looks like a chapter list.
 *
 * Two properties define a real one, and both are cheap to check:
 *  - **coverage** — a chapter list *enumerates* chapters, so the entries it
 *    produced should account for most of the chapter range they span. A table
 *    misread into a handful of scattered numbers won't.
 *  - **monotonicity** — later chapters live in later volumes. Always. A parse
 *    that puts chapter 2 in volume 14 and chapter 3 in volume 5 read the wrong
 *    columns.
 *
 * @param {Map<string,string>} map chapter number → volume number
 * @returns {{ entries:number, coverage:number, monotonic:number, minCh:number, maxCh:number, volumes:number }}
 */
export function chapterMapQuality(map) {
  const pairs = [...(map || new Map()).entries()]
    .map(([ch, vol]) => [parseFloat(ch), parseFloat(vol)])
    .filter(([c, v]) => Number.isFinite(c) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (!pairs.length) return { entries: 0, coverage: 0, monotonic: 0, minCh: 0, maxCh: 0, volumes: 0 };

  const minCh = pairs[0][0], maxCh = pairs[pairs.length - 1][0];
  const span = Math.max(1, maxCh - minCh + 1);
  let ordered = 0;
  for (let i = 1; i < pairs.length; i++) if (pairs[i][1] >= pairs[i - 1][1]) ordered++;
  return {
    entries: pairs.length,
    coverage: Math.min(1, pairs.length / span),
    monotonic: pairs.length > 1 ? ordered / (pairs.length - 1) : 1,
    minCh, maxCh,
    volumes: new Set(pairs.map(p => p[1])).size,
  };
}

/**
 * Fail-closed acceptance test for a parsed page's map.
 *
 * Live-validated against the English Wikipedia: "List of Bleach chapters
 * (188–423)" scores coverage 0.56 / monotonic 1.00 and passes, while
 * "List of Berserk chapters" (23 scattered entries over a 0–4106 range, volumes
 * jumping 1→14→5→11) and "Lists of One Piece chapters" (11 entries reading
 * years and ISBN fragments as chapters) score ~0.006 coverage and fail. Both of
 * those used to reach the consensus and were only stopped further downstream by
 * the physical-plausibility band — i.e. by luck, not by a check that knew they
 * were garbage.
 */
export function looksLikeChapterList(map, { minEntries = 5, minCoverage = 0.4, minMonotonic = 0.9 } = {}) {
  const q = chapterMapQuality(map);
  return q.entries >= minEntries && q.coverage >= minCoverage && q.monotonic >= minMonotonic;
}
