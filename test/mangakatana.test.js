import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB/paths before any module reads config.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-mk-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { parseSearchResults, parseChapterList, parseChapterImages } = await import('../src/providers/mangakatana.js');
const { isImageBuffer } = await import('../src/download/downloader.js');
const { throttle, _resetThrottle } = await import('../src/download/throttle.js');
const { cookieHeader } = await import('../src/download/flaresolverr.js');
const { normTitle, titlesMatch } = await import('../src/core/library.js');
const { isProviderEnabled } = await import('../src/core/settings.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

test('isImageBuffer accepts real image bytes, rejects HTML/garbage', () => {
  assert.equal(isImageBuffer(PNG), true, 'PNG');
  assert.equal(isImageBuffer(JPEG), true, 'JPEG');
  assert.equal(isImageBuffer(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary')), true, 'WEBP');
  // A Cloudflare/HTML error page served with status 200 must be rejected.
  assert.equal(isImageBuffer(Buffer.from('<!DOCTYPE html><html><head><title>Just a moment...</title>')), false, 'HTML challenge');
  assert.equal(isImageBuffer(Buffer.from('not an image at all, just text padding bytes')), false, 'text/.bin');
  assert.equal(isImageBuffer(Buffer.alloc(0)), false, 'empty');
});

test('MangaKatana: parseSearchResults extracts series links, skips chapter links', () => {
  const html = `
    <div id="book_list">
      <div class="item"><h3 class="title"><a href="https://mangakatana.com/manga/dandadan.25806">Dandadan</a></h3></div>
      <div class="item"><h3 class="title"><a href="https://mangakatana.com/manga/some-other.999">Some Other</a></h3></div>
      <a href="https://mangakatana.com/manga/dandadan.25806/c1">Chapter 1</a>
    </div>`;
  const out = parseSearchResults(html);
  const titles = out.map(o => o.title);
  assert.ok(titles.includes('Dandadan'), 'finds Dandadan series');
  assert.ok(titles.includes('Some Other'), 'finds second series');
  assert.ok(out.every(o => !/\/c\d/.test(o.url.replace(/\/manga\/[^/]+/, ''))), 'no chapter links among results');
});

test('MangaKatana: parseChapterList maps chapter numbers to URLs', () => {
  const html = `
    <div class="chapters">
      <table class="uk-table"><tbody>
        <tr class="chapter"><a href="https://mangakatana.com/manga/dandadan.25806/c1">Chapter 1</a></tr>
        <tr class="chapter"><a href="https://mangakatana.com/manga/dandadan.25806/c10">Chapter 10</a></tr>
        <tr class="chapter"><a href="https://mangakatana.com/manga/dandadan.25806/c10.5">Chapter 10.5</a></tr>
      </tbody></table>
    </div>`;
  const map = parseChapterList(html);
  assert.equal(map.get('1'), 'https://mangakatana.com/manga/dandadan.25806/c1');
  assert.equal(map.get('10'), 'https://mangakatana.com/manga/dandadan.25806/c10');
  assert.equal(map.get('10.5'), 'https://mangakatana.com/manga/dandadan.25806/c10.5');
});

test('MangaKatana: parseChapterImages reads inline-script array, ignores chrome/ads', () => {
  const html = `
    <img src="https://mangakatana.com/static/logo.png">
    <div id="imgs"></div>
    <script>
      var thzq=['https://cdn.mangakatana.com/img/d/1.jpg','https://cdn.mangakatana.com/img/d/2.jpg','https://cdn.mangakatana.com/img/d/3.jpg'];
      $(function(){ /* build reader */ });
    </script>`;
  const imgs = parseChapterImages(html);
  assert.deepEqual(imgs, [
    'https://cdn.mangakatana.com/img/d/1.jpg',
    'https://cdn.mangakatana.com/img/d/2.jpg',
    'https://cdn.mangakatana.com/img/d/3.jpg',
  ]);
  assert.ok(!imgs.some(u => /logo|static/.test(u)), 'logo excluded');
});

test('MangaKatana: parseChapterImages falls back to <img data-src>', () => {
  const html = `
    <div id="imgs">
      <div class="wrap_img"><img data-src="https://cdn.mkk.com/a/01.webp"></div>
      <div class="wrap_img"><img data-src="https://cdn.mkk.com/a/02.webp"></div>
    </div>`;
  const imgs = parseChapterImages(html);
  assert.deepEqual(imgs, ['https://cdn.mkk.com/a/01.webp', 'https://cdn.mkk.com/a/02.webp']);
});

test('throttle spaces same-key calls, lets different keys run freely', async () => {
  _resetThrottle();
  const t0 = Date.now();
  await throttle('k1', 0); // disabled → immediate
  assert.ok(Date.now() - t0 < 50, 'zero interval is immediate');

  const start = Date.now();
  await throttle('site', 100);
  await throttle('site', 100);
  await throttle('site', 100);
  // 3 sequential calls at 100ms spacing ≈ ≥200ms between first and third.
  assert.ok(Date.now() - start >= 180, `same-key spacing enforced (took ${Date.now() - start}ms)`);

  const s2 = Date.now();
  await Promise.all([throttle('a', 100), throttle('b', 100), throttle('c', 100)]);
  assert.ok(Date.now() - s2 < 120, 'different keys do not block each other');
});

test('cookieHeader builds a Cookie string from FlareSolverr cookies', () => {
  assert.equal(
    cookieHeader([{ name: 'cf_clearance', value: 'abc' }, { name: 'x', value: 'y' }]),
    'cf_clearance=abc; x=y'
  );
  assert.equal(cookieHeader([]), '');
});

test('titlesMatch / normTitle handle punctuation and prefixes', () => {
  assert.equal(normTitle('Dandadan!! (2021)'), 'dandadan 2021');
  assert.equal(titlesMatch('Dandadan', 'dandadan'), true);
  assert.equal(titlesMatch('Absolute Wonder Woman', 'Absolute Wonder Woman (2024)'), true);
  assert.equal(titlesMatch('One Piece', 'Naruto'), false);
  assert.equal(titlesMatch('', 'x'), false);
});

test('MangaKatana provider is registered but disabled by default', () => {
  assert.equal(isProviderEnabled('mangakatana'), false, 'opt-in scraper stays disabled until enabled');
});
