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

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, listChaptersForSeries, upsertChapter, setChapterState } = await import('../src/core/repo.js');
const { buildComicInfoXml } = await import('../src/core/comicinfo.js');
const { issueCbzName, volumeCbzName } = await import('../src/core/packager.js');
const { extractToStaging } = await import('../src/download/archive-downloader.js');
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
    <a class="aio-button" href="https://pixeldrain.com/api/file/abc">Pixeldrain</a>
    <a class="aio-red" href="https://getcomics.org/dlds/12345/">DOWNLOAD NOW</a>
    <a href="https://example.com/random">unrelated</a>`;
  const links = extractDownloadLinks(post);
  // "DOWNLOAD NOW" main DDL outranks the mirror; unrelated link excluded.
  assert.equal(links[0], 'https://getcomics.org/dlds/12345/');
  assert.ok(links.includes('https://pixeldrain.com/api/file/abc'));
  assert.ok(!links.includes('https://example.com/random'));
});
