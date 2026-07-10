import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-comic-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded, setSetting } = await import('../src/core/settings.js');
const { createSeries, listChaptersForSeries, upsertChapter, setChapterState } = await import('../src/core/repo.js');
const { buildComicInfoXml } = await import('../src/core/comicinfo.js');
const { issueCbzName, volumeCbzName } = await import('../src/core/packager.js');
const { extractToStaging, downloadArchiveChapter, extractMediafireDirect, extractWetransferParams } = await import('../src/download/archive-downloader.js');
const { bindChapter } = await import('../src/core/binder.js');
const { readCbzInfo } = await import('../src/core/library-scan.js');
const { parseSearchResults, extractDownloadLinks } = await import('../src/providers/getcomics.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

function makeCbzBuffer(names) {
  const z = new AdmZip();
  for (const n of names) z.addFile(n, PNG);
  return z.toBuffer();
}

test('ComicInfo comic mode: Publisher set, no Manga/B&W flags, ComicVine Web', () => {
  const xml = buildComicInfoXml({
    series: 'Saga (2012)', number: '12', title: 'Chapter Twelve',
    authors: ['Brian K. Vaughan'], artists: ['Fiona Staples'],
    publisher: 'Image Comics', year: 2014, mediaType: 'comic',
    web: 'https://comicvine.gamespot.com/volume/4050-42562/',
  });
  assert.match(xml, /<Publisher>Image Comics<\/Publisher>/);
  assert.match(xml, /<Number>12<\/Number>/);
  assert.match(xml, /<Title>Chapter Twelve<\/Title>/);
  assert.match(xml, /comicvine\.gamespot\.com\/volume\/4050-42562/);
  assert.doesNotMatch(xml, /<Manga>/);
  assert.doesNotMatch(xml, /<BlackAndWhite>/);
});

test('manga mode still emits Manga + B&W flags (right-to-left pagination)', () => {
  const xml = buildComicInfoXml({ series: 'X', number: '1', mediaType: 'manga' });
  assert.match(xml, /<Manga>YesAndRightToLeft<\/Manga>/);
  assert.match(xml, /<BlackAndWhite>Yes<\/BlackAndWhite>/);
});

test('ComicInfo enrichment: Count from total volumes, SeriesSort drops leading article, localized volume title', () => {
  const xml = buildComicInfoXml({
    series: 'The Promised Neverland', volumeNum: '3', mediaType: 'manga',
    totalVolumes: 20, volumeTitle: 'Destroy',
  });
  assert.match(xml, /<Count>20<\/Count>/);
  assert.match(xml, /<SeriesSort>Promised Neverland<\/SeriesSort>/);
  assert.match(xml, /<Title>Destroy<\/Title>/); // localized volume title beats "…, Vol. 3"
  // A series without a leading article emits no SeriesSort (nothing to reorder).
  assert.doesNotMatch(buildComicInfoXml({ series: 'Berserk', volumeNum: '1' }), /<SeriesSort>/);
  // No Count when the total is unknown.
  assert.doesNotMatch(buildComicInfoXml({ series: 'Berserk', volumeNum: '1' }), /<Count>/);
});

test('issue/volume CBZ filenames', () => {
  assert.equal(issueCbzName('Saga', '1'), 'Saga #001.cbz');
  assert.equal(issueCbzName('Saga', '54'), 'Saga #054.cbz');
  assert.equal(issueCbzName('Saga', '1.5'), 'Saga #001.5.cbz');
  assert.equal(volumeCbzName('Saga', '3'), 'Saga Vol. 03.cbz');
});

test('extractToStaging unpacks a CBZ into the page-staging layout', async () => {
  const buf = makeCbzBuffer(['page-02.jpg', 'page-01.jpg', 'cover.png', 'notes.txt']);
  const { dir, pageCount } = await extractToStaging(buf, 999, '7');
  assert.equal(pageCount, 3); // txt skipped
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ['001.png', '002.jpg', '003.jpg']); // numeric-sorted, renumbered
});

test('comic download→bind produces a #NNN issue CBZ with comic ComicInfo', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: '42562', mediaType: 'comic',
    downloadProvider: 'getcomics', publisher: 'Image Comics',
    title: 'Saga (2012)', authors: ['Brian K. Vaughan'], language: 'en',
    monitored: true, packagingMode: 'chapter',
  });
  upsertChapter(s.id, { provider: 'comicvine', number: '1', title: 'Chapter One' });
  const row = listChaptersForSeries(s.id).find(c => c.number === '1');

  // Simulate the GetComics archive download by extracting a synthetic CBZ.
  const { dir } = await extractToStaging(makeCbzBuffer(['001.jpg', '002.jpg']), s.id, '1');
  setChapterState(row.id, 'downloaded', { staging_path: dir, pages: 2 });

  const res = await bindChapter({ ...s }, listChaptersForSeries(s.id).find(c => c.number === '1'));
  assert.ok(res.path.endsWith('Saga (2012) #001.cbz'), `got ${res.path}`);

  // The produced CBZ carries comic identity (ComicVine web id + Publisher) and chapter pages.
  const info = await readCbzInfo(res.path);
  assert.equal(info.comicvineId, '42562');
  assert.deepEqual(info.chapters.sort(), ['1']);
  const xml = new AdmZip(res.path).getEntries().find(e => /comicinfo\.xml$/i.test(e.entryName)).getData().toString();
  assert.match(xml, /<Publisher>Image Comics<\/Publisher>/);
  assert.doesNotMatch(xml, /<Manga>/);
});

test('getcomics HTML parsers extract posts and ranked download links', () => {
  const listing = `
    <article><h1 class="post-title"><a href="https://getcomics.org/comic/saga-001/">Saga #1 (2012)</a></h1></article>
    <article><h1 class="post-title"><a href="https://getcomics.org/comic/saga-002/">Saga #2 (2012)</a></h1></article>`;
  const posts = parseSearchResults(listing);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, 'https://getcomics.org/comic/saga-001/');
  assert.match(posts[0].title, /Saga #1/);

  const post = `
    <a class="aio-button" href="https://getcomics.org/dls/PIX/">Pixeldrain</a>
    <a class="aio-red" href="https://getcomics.org/dls/MAIN/">DOWNLOAD NOW</a>
    <a class="aio-button" href="https://getcomics.org/dls/WET/">WeTransfer</a>
    <a href="https://example.com/random">unrelated</a>`;
  const links = extractDownloadLinks(post);
  // Every /dls/ mirror is captured regardless of label, ranked pixeldrain (un-gated
  // direct API) > main DDL > any other mirror (e.g. WeTransfer) as a last resort.
  // The main DDL and the unlabelled-by-our-rules WeTransfer are both kept as
  // fallback candidates; the unrelated link is excluded.
  assert.deepEqual(links, [
    'https://getcomics.org/dls/PIX/',
    'https://getcomics.org/dls/MAIN/',
    'https://getcomics.org/dls/WET/',
  ]);
  assert.ok(!links.includes('https://example.com/random'));
});

test('archive download: a 403 from a Cloudflare-guarded mirror retries via FlareSolverr', async () => {
  // Regression for GetComics DDL links that redirect to a Cloudflare-challenged
  // mirror host (fs*.comicfiles.ru, etc.) — a Referer header alone still 403s;
  // only a solved cf_clearance cookie gets past it (same fix as MangaKatana).
  // Also covers two non-obvious failure modes found after the first fix shipped:
  //   - FlareSolverr must be pointed at the mirror's origin root, never the exact
  //     file URL (solving the file URL crashes FlareSolverr's browser once the
  //     challenge passes and it tries to natively download the response).
  //   - The retry must hit the resolved mirror URL directly, not the original
  //     getcomics.org/dls/… link — a Cookie header doesn't survive fetch()'s
  //     cross-origin redirect, so retrying the redirecting link would silently
  //     drop the solved session on the second hop.
  setSetting('flaresolverrUrl', 'http://flaresolverr.local/v1');
  const zipBuf = makeCbzBuffer(['001.jpg']);
  const dlsUrl = 'https://getcomics.org/dls/abc';
  const mirrorFileUrl = 'https://mirror.example/2024/file.cbz';
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, headers: opts?.headers || {} });
    if (u.includes('flaresolverr.local')) {
      const { url: solvedUrl } = JSON.parse(opts.body);
      assert.equal(solvedUrl, 'https://mirror.example/', 'solves the mirror origin root, not the file URL');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          solution: { response: '', cookies: [{ name: 'cf_clearance', value: 'solved-token' }], userAgent: 'SolvedUA/1.0', status: 200 },
        }),
      };
    }
    if (u === dlsUrl) {
      // Simulates fetch() transparently following the 302 to the mirror: status/url
      // reflect the final hop, same as a real fetch() Response after redirection.
      return { ok: false, status: 403, url: mirrorFileUrl, headers: { get: () => null } };
    }
    if (u === mirrorFileUrl) {
      const solved = (opts?.headers || {}).Cookie === 'cf_clearance=solved-token';
      if (!solved) return { ok: false, status: 403, url: mirrorFileUrl, headers: { get: () => null } };
      return { ok: true, status: 200, url: mirrorFileUrl, headers: { get: () => null }, arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const provider = {
      name: 'getcomics', capabilities: { archive: true },
      findIssueDownload: async () => ({ url: dlsUrl, headers: { Referer: 'https://getcomics.org/comic/x/' } }),
    };
    const { pageCount } = await downloadArchiveChapter(provider, { id: 999, title: 'Test' }, { number: '1' });
    assert.equal(pageCount, 1);
    const solvedRetry = calls.find(c => c.url === mirrorFileUrl && c.headers.Cookie === 'cf_clearance=solved-token');
    assert.ok(solvedRetry, 'retried the resolved mirror URL directly with the FlareSolverr-solved cookie');
    assert.equal(solvedRetry.headers['User-Agent'], 'SolvedUA/1.0', 'reuses the browser UA FlareSolverr solved with');
  } finally {
    globalThis.fetch = origFetch;
    setSetting('flaresolverrUrl', '');
  }
});

test('archive download: falls back to the pixeldrain mirror when the main server is Cloudflare-blocked', async () => {
  // The real-world failure: GetComics' top "main server" mirror redirects to a
  // Cloudflare-gated comicfiles.ru host that FlareSolverr times out solving. The
  // downloader must move on to the next candidate — pixeldrain — whose /u/{id}
  // viewer URL we rewrite to the un-gated /api/file/{id} direct download.
  setSetting('flaresolverrUrl', ''); // no solver available → main server can't be rescued
  const zipBuf = makeCbzBuffer(['001.jpg', '002.jpg']);
  const arrBuf = () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
  const mainDls = 'https://getcomics.org/dls/MAIN';
  const pxDls = 'https://getcomics.org/dls/PX';
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    // Main server → follows 302 to a Cloudflare-challenged mirror serving an HTML
    // challenge page with a 403.
    if (u === mainDls) return { ok: false, status: 403, url: 'https://fs2.comicfiles.ru/x.cbz', headers: { get: () => 'text/html' } };
    // Pixeldrain DDL → 302 to its HTML *viewer* page (200, but not the file).
    if (u === pxDls) return { ok: true, status: 200, url: 'https://pixeldrain.com/u/sZZFJbou', headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0) };
    // The rewritten direct-download API serves the real archive.
    if (u === 'https://pixeldrain.com/api/file/sZZFJbou') {
      return { ok: true, status: 200, url: u, headers: { get: () => 'application/vnd.comicbook+zip' }, arrayBuffer: arrBuf };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const provider = {
      name: 'getcomics', capabilities: { archive: true },
      findIssueDownload: async () => ({ urls: [mainDls, pxDls], url: mainDls, headers: { Referer: 'https://getcomics.org/comic/x/' } }),
    };
    const { pageCount } = await downloadArchiveChapter(provider, { id: 998, title: 'Test' }, { number: '3' });
    assert.equal(pageCount, 2, 'archive extracted from the pixeldrain fallback');
    assert.ok(seen.includes(mainDls), 'tried the main server first');
    assert.ok(seen.includes('https://pixeldrain.com/api/file/sZZFJbou'), 'rewrote the pixeldrain viewer URL to the direct-download API');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('extractMediafireDirect pulls the direct download link from a /file/ landing page', () => {
  const page = `<a aria-label="Download file" class="input popsok"
        href="https://download941.mediafire.com/abc123/u1oep9/Star+Wars.cbz?x=1&amp;y=2"
        id="downloadButton" rel="nofollow">Download (230MB)</a>`;
  assert.equal(
    extractMediafireDirect(page),
    'https://download941.mediafire.com/abc123/u1oep9/Star+Wars.cbz?x=1&y=2', // &amp; decoded
  );
  // Base64 `data-scrambled-url` fallback used on some newer pages.
  const scrambled = Buffer.from('https://download9.mediafire.com/z/f.cbz').toString('base64');
  assert.equal(extractMediafireDirect(`<a data-scrambled-url="${scrambled}">x</a>`), 'https://download9.mediafire.com/z/f.cbz');
  // No recognisable link → null (lets the caller fall through to the next mirror).
  assert.equal(extractMediafireDirect('<html>no link here</html>'), null);
});

test('archive download: resolves a MediaFire landing page to its direct download', async () => {
  // Real-world #6 failure: the only working mirror was MediaFire, whose /file/ URL
  // is an HTML landing page (rejected as "not an archive"). The downloader must
  // parse the download button and fetch the real download*.mediafire.com link.
  setSetting('flaresolverrUrl', '');
  const zipBuf = makeCbzBuffer(['001.jpg']);
  const arrBuf = () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
  const mfDls = 'https://getcomics.org/dls/MF';
  const mfPage = 'https://www.mediafire.com/file_premium/u1oep9/Star_Wars.cbz/file';
  const mfDirect = 'https://download941.mediafire.com/abc/u1oep9/Star+Wars.cbz';
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    // /dls/ redirector → 302 to the MediaFire HTML landing page.
    if (u === mfDls) {
      return { ok: true, status: 200, url: mfPage, headers: { get: () => 'text/html' },
        text: async () => `<a id="downloadButton" href="${mfDirect}" rel="nofollow">Download</a>` };
    }
    if (u === mfDirect) {
      return { ok: true, status: 200, url: u, headers: { get: () => 'application/zip' }, arrayBuffer: arrBuf };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const provider = {
      name: 'getcomics', capabilities: { archive: true },
      findIssueDownload: async () => ({ urls: [mfDls], url: mfDls, headers: { Referer: 'https://getcomics.org/comic/x/' } }),
    };
    const { pageCount } = await downloadArchiveChapter(provider, { id: 997, title: 'Test' }, { number: '6' });
    assert.equal(pageCount, 1, 'archive extracted from the resolved MediaFire direct link');
    assert.ok(seen.includes(mfDirect), 'fetched the parsed download*.mediafire.com direct link');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('extractWetransferParams reads transfer id + security hash (+ csrf) from a download page', () => {
  const url = 'https://wetransfer.com/downloads/e791f84684db9a31e772c291f8c1dcf420241107013628/7ecc69?t_exp=1';
  const html = '<meta name="csrf-token" content="TOKEN123"><script>{"securityHash":"7ecc69"}</script>';
  assert.deepEqual(extractWetransferParams(url, html), {
    transferId: 'e791f84684db9a31e772c291f8c1dcf420241107013628',
    securityHash: '7ecc69',
    csrf: 'TOKEN123',
  });
  // Three-segment (recipient) form: id/recipient/hash — hash is the last segment.
  const three = extractWetransferParams('https://wetransfer.com/downloads/abcdef/recipientid/9f9f9f', '');
  assert.equal(three.transferId, 'abcdef');
  assert.equal(three.securityHash, '9f9f9f');
  // A non-WeTransfer / malformed URL → null (caller falls through to next mirror).
  assert.equal(extractWetransferParams('https://example.com/x', ''), null);
});

test('archive download: resolves a WeTransfer page via its download API', async () => {
  // Best-effort last-resort mirror. Live GetComics WeTransfer links are almost
  // always expired/DMCA-blocked, so this exercises the flow with a mocked live
  // transfer: page → POST /api/v4/transfers/{id}/download → direct storage link.
  setSetting('flaresolverrUrl', '');
  const zipBuf = makeCbzBuffer(['001.jpg']);
  const arrBuf = () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
  const wtDls = 'https://getcomics.org/dls/WT';
  const wtPage = 'https://wetransfer.com/downloads/abc123def/7ecc69';
  const api = 'https://wetransfer.com/api/v4/transfers/abc123def/download';
  const direct = 'https://storage.example/transfer/StarWars.cbz';
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    seen.push({ u, method: opts?.method || 'GET', body: opts?.body });
    if (u === wtDls) {
      return { ok: true, status: 200, url: wtPage,
        headers: { get: () => 'text/html', getSetCookie: () => ['wt_session=xyz; Path=/'] },
        text: async () => '<meta name="csrf-token" content="TOK"><script>{"securityHash":"7ecc69"}</script>' };
    }
    if (u === api) {
      assert.equal(opts.method, 'POST');
      assert.match(String(opts.headers.Cookie), /wt_session=xyz/);
      assert.equal(opts.headers['x-csrf-token'], 'TOK');
      assert.match(String(opts.body), /"security_hash":"7ecc69"/);
      return { ok: true, status: 200, json: async () => ({ direct_link: direct }) };
    }
    if (u === direct) {
      return { ok: true, status: 200, url: u, headers: { get: () => 'application/zip' }, arrayBuffer: arrBuf };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const provider = {
      name: 'getcomics', capabilities: { archive: true },
      findIssueDownload: async () => ({ urls: [wtDls], url: wtDls, headers: { Referer: 'https://getcomics.org/comic/x/' } }),
    };
    const { pageCount } = await downloadArchiveChapter(provider, { id: 996, title: 'Test' }, { number: '3' });
    assert.equal(pageCount, 1, 'archive extracted from the resolved WeTransfer direct link');
    assert.ok(seen.some(s => s.u === api && s.method === 'POST'), 'called the WeTransfer download API');
    assert.ok(seen.some(s => s.u === direct), 'fetched the returned direct storage link');
  } finally {
    globalThis.fetch = origFetch;
  }
});
