import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Regression and feature coverage for CBR/RAR and loose image support in
// POST /series/:id/upload-chapter and POST /series/:id/upload-volume.
// Ensures .cbr/.rar extensions are preserved and routed properly, flat/hierarchical
// modes work with both archives and loose images, and constraints are enforced.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-upload-cbr-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { setSetting } = await import('../src/core/settings.js');
const { createSeries, listChaptersForSeries, upsertChapter, getChapter } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
setSetting('downloadsPaused', true);
after(async () => { await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

function makeArchiveBuffer(entries = ['001.png']) {
  const z = new AdmZip();
  for (const name of entries) z.addFile(name, PNG);
  return z.toBuffer();
}

function buildMultipart(fields = {}, files = []) {
  const boundary = 'mbTestBoundaryCbr123';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`));
    chunks.push(f.buf);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), boundary };
}

async function uploadToEndpoint(url, fields, files) {
  const { payload, boundary } = buildMultipart(fields, files);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

test('upload-volume: flat mode with .cbr and .rar archives preserves extension and links to tracked chapters', async () => {
  const s = createSeries({ provider: 'manual', providerSeriesId: 'cbr1', title: 'CBR Flat Manga', packagingMode: 'volume' });
  upsertChapter(s.id, { provider: 'manual', number: 1, volume: '1' }, 'wanted');
  upsertChapter(s.id, { provider: 'manual', number: 2, volume: '1' }, 'wanted');

  // Upload a .cbr file for Volume 1
  const cbrBuf = makeArchiveBuffer(['page1.png', 'page2.png']);
  const resCbr = await uploadToEndpoint(`/api/series/${s.id}/upload-volume`, { volume: '1' }, [
    { filename: 'CBR Flat Manga Vol 1.cbr', buf: cbrBuf }
  ]);
  assert.equal(resCbr.statusCode, 200, resCbr.body);
  const dataCbr = resCbr.json();
  assert.equal(dataCbr.ok, true);
  assert.equal(dataCbr.mode, 'flat');
  assert.equal(dataCbr.linkedChapters.length, 2);

  // Check file on disk and bindery state
  const expectedCbrPath = path.join(process.env.OUTPUT_DIR, 'CBR Flat Manga', 'CBR Flat Manga Vol. 01.cbr');
  assert.equal(existsSync(expectedCbrPath), true, `File should exist at ${expectedCbrPath}`);
  const chaptersVol1 = listChaptersForSeries(s.id).filter(c => c.volume === '1');
  for (const c of chaptersVol1) {
    assert.equal(c.state, 'bindery');
    assert.equal(c.cbz_path, expectedCbrPath);
  }

  // Upload a .rar file for Volume 2
  upsertChapter(s.id, { provider: 'manual', number: 3, volume: '2' }, 'wanted');
  const rarBuf = makeArchiveBuffer(['p1.png']);
  const resRar = await uploadToEndpoint(`/api/series/${s.id}/upload-volume`, { volume: '2' }, [
    { filename: 'CBR Flat Manga Vol 2.rar', buf: rarBuf }
  ]);
  assert.equal(resRar.statusCode, 200, resRar.body);
  const dataRar = resRar.json();
  assert.equal(dataRar.ok, true);
  assert.equal(dataRar.mode, 'flat');

  const expectedRarPath = path.join(process.env.OUTPUT_DIR, 'CBR Flat Manga', 'CBR Flat Manga Vol. 02.rar');
  assert.equal(existsSync(expectedRarPath), true, `File should exist at ${expectedRarPath}`);
  const ch3 = listChaptersForSeries(s.id).find(c => String(c.number) === '3');
  assert.equal(ch3.state, 'bindery');
  assert.equal(ch3.cbz_path, expectedRarPath);
});

test('upload-volume: loose images in flat mode build a volume CBZ and link to tracked chapters', async () => {
  const s = createSeries({ provider: 'manual', providerSeriesId: 'cbr2', title: 'Loose Flat Manga', packagingMode: 'volume' });
  upsertChapter(s.id, { provider: 'manual', number: 10, volume: '3' }, 'wanted');
  upsertChapter(s.id, { provider: 'manual', number: 11, volume: '3' }, 'wanted');

  const res = await uploadToEndpoint(`/api/series/${s.id}/upload-volume`, { volume: '3' }, [
    { filename: '001.png', buf: PNG },
    { filename: '002.png', buf: PNG }
  ]);
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json();
  assert.equal(data.ok, true);
  assert.equal(data.mode, 'flat');
  assert.equal(data.linkedChapters.length, 2);

  const expectedCbzPath = path.join(process.env.OUTPUT_DIR, 'Loose Flat Manga', 'Loose Flat Manga Vol. 03.cbz');
  assert.equal(existsSync(expectedCbzPath), true);
  const chaps = listChaptersForSeries(s.id).filter(c => c.volume === '3');
  assert.equal(chaps.every(c => c.state === 'bindery' && c.cbz_path === expectedCbzPath), true);
});

test('upload-volume: folder-per-chapter archive splits into per-chapter staging and package', async () => {
  const s = createSeries({ provider: 'comicvine', providerSeriesId: 'cbr3', downloadProvider: 'getcomics', mediaType: 'comic', monitored: true, title: 'Loose Hierarchical Manga', packagingMode: 'chapter' });
  const archiveBuf = makeArchiveBuffer(['Chapter 20/page1.png', 'Chapter 20/page2.png', 'Chapter 21/page1.png']);
  const res = await uploadToEndpoint(`/api/series/${s.id}/upload-volume`, { volume: '1' }, [
    { filename: 'vol1.cbr', buf: archiveBuf }
  ]);
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json();
  assert.equal(data.ok, true);
  assert.equal(data.mode, 'hierarchical');
  assert.deepEqual(data.chapters.map(String).sort(), ['20', '21']);

  const ch20 = listChaptersForSeries(s.id).find(c => String(c.number) === '20');
  const ch21 = listChaptersForSeries(s.id).find(c => String(c.number) === '21');
  assert.equal(ch20.state, 'bindery');
  assert.equal(ch21.state, 'bindery');
  assert.equal(existsSync(ch20.cbz_path), true);
  assert.equal(existsSync(ch21.cbz_path), true);
});

test('upload-chapter: accepts .cbr extension and loose image files', async () => {
  const s = createSeries({ provider: 'comicvine', providerSeriesId: 'cbr4', downloadProvider: 'getcomics', mediaType: 'comic', monitored: true, title: 'Chapter Upload Manga', packagingMode: 'chapter' });

  // 1. Upload .cbr archive for Chapter 5
  const cbrBuf = makeArchiveBuffer(['01.png', '02.png']);
  const resCbr = await uploadToEndpoint(`/api/series/${s.id}/upload-chapter`, { chapterNumber: '5' }, [
    { filename: 'Chapter 5.cbr', buf: cbrBuf }
  ]);
  assert.equal(resCbr.statusCode, 200, resCbr.body);
  const ch5 = listChaptersForSeries(s.id).find(c => String(c.number) === '5');
  assert.equal(ch5.state, 'bindery');
  assert.equal(existsSync(ch5.cbz_path), true);

  // 2. Upload loose images for Chapter 6
  const resLoose = await uploadToEndpoint(`/api/series/${s.id}/upload-chapter`, { chapterNumber: '6' }, [
    { filename: 'page1.png', buf: PNG },
    { filename: 'page2.png', buf: PNG }
  ]);
  assert.equal(resLoose.statusCode, 200, resLoose.body);
  const ch6 = listChaptersForSeries(s.id).find(c => String(c.number) === '6');
  assert.equal(ch6.state, 'bindery');
  assert.equal(existsSync(ch6.cbz_path), true);
});

test('validation: rejects mixing archive and loose images in one upload', async () => {
  const s = createSeries({ provider: 'manual', providerSeriesId: 'cbr5', title: 'Validation Manga', packagingMode: 'chapter' });
  const archiveBuf = makeArchiveBuffer(['01.png']);

  const resVol = await uploadToEndpoint(`/api/series/${s.id}/upload-volume`, { volume: '1' }, [
    { filename: 'Vol 1.cbr', buf: archiveBuf },
    { filename: 'extra.png', buf: PNG }
  ]);
  assert.equal(resVol.statusCode, 400);
  assert.match(resVol.json().error, /cannot mix an archive and loose images/i);

  const resCh = await uploadToEndpoint(`/api/series/${s.id}/upload-chapter`, { chapterNumber: '1' }, [
    { filename: 'Chapter 1.cbr', buf: archiveBuf },
    { filename: 'extra.png', buf: PNG }
  ]);
  assert.equal(resCh.statusCode, 400);
  assert.match(resCh.json().error, /cannot mix an archive and loose images/i);
});
