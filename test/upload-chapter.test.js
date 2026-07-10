import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Regression coverage for POST /series/:id/upload-chapter — manually uploading a
// CBZ/ZIP or loose page images for a chapter no download provider could find.
// The route must feed the SAME staging -> bind/package pipeline a real download
// uses (packageSingleChapter / packageCompleteVolumes), not a parallel path.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-upload-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { setSetting } = await import('../src/core/settings.js');
const { createSeries, getChapter, listChaptersForSeries, upsertChapter, setChapterState } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
setSetting('downloadsPaused', true); // don't let the worker grab anything mid-test
after(async () => { await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

function makeCbzBuffer(names) {
  const z = new AdmZip();
  for (const n of names) z.addFile(n, PNG);
  return z.toBuffer();
}

/** Hand-build a multipart/form-data body for app.inject() (no test-only dependency). */
function buildMultipart(fields = {}, files = []) {
  const boundary = 'mbTestBoundary123456';
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

async function upload(seriesId, fields, files) {
  const { payload, boundary } = buildMultipart(fields, files);
  return app.inject({
    method: 'POST',
    url: `/api/series/${seriesId}/upload-chapter`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

test('upload-chapter: CBZ upload on a chapter-packaging series feeds packageSingleChapter', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'up1', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Test Comic', language: 'en',
    monitored: true, packagingMode: 'chapter',
  });
  const cbz = makeCbzBuffer(['001.jpg', '002.jpg']);
  const res = await upload(s.id, { chapterNumber: '5' }, [{ filename: 'issue5.cbz', buf: cbz }]);

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'chapter');
  assert.ok(body.path, 'returns the packaged CBZ path');
  assert.ok(existsSync(body.path), 'packaged CBZ actually exists on disk');

  const chapter = listChaptersForSeries(s.id).find(c => c.number === '5');
  assert.equal(chapter.state, 'bindery');
  assert.equal(chapter.cbz_path, body.path);
  assert.equal(chapter.pages, 2);
});

test('upload-chapter: loose images fill in the missing chapter of an otherwise-complete volume', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'up2', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Volume Test', language: 'en',
    monitored: true, packagingMode: 'volume', status: 'completed', // status=completed => volume is "closed"
  });
  // Sibling chapter already owned.
  upsertChapter(s.id, { provider: 'manual', number: '1', volume: '1' }, 'imported');
  const owned = listChaptersForSeries(s.id).find(c => c.number === '1');
  setChapterState(owned.id, 'imported', { cbz_path: path.join(tmp, 'fake-owned.cbz'), pages: 3 });
  // The chapter we're about to upload — not yet downloaded.
  upsertChapter(s.id, { provider: 'manual', number: '2', volume: '1' }, 'wanted');

  const res = await upload(s.id, { chapterNumber: '2' }, [
    { filename: 'p1.jpg', buf: PNG, contentType: 'image/jpeg' },
    { filename: 'p2.jpg', buf: PNG, contentType: 'image/jpeg' },
  ]);

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'volume');
  assert.equal(body.importedVolumes, 1, 'the now-complete volume got packaged');

  const uploaded = listChaptersForSeries(s.id).find(c => c.number === '2');
  assert.equal(uploaded.state, 'bindery');
  assert.equal(uploaded.pages, 2);
  assert.ok(uploaded.cbz_path && existsSync(uploaded.cbz_path));
});

test('upload-chapter: creates a brand-new chapter row for an untracked number', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'up3', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload New Chapter Test', language: 'en',
    monitored: true, packagingMode: 'chapter',
  });
  assert.equal(listChaptersForSeries(s.id).length, 0);

  const res = await upload(s.id, { chapterNumber: '12' }, [
    { filename: 'p1.jpg', buf: PNG, contentType: 'image/jpeg' },
  ]);
  assert.equal(res.statusCode, 200, res.body);

  const chapters = listChaptersForSeries(s.id);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].number, '12');
  assert.equal(chapters[0].provider, 'manual');
  assert.equal(chapters[0].state, 'bindery');
});

test('upload-chapter: re-uploading an owned chapter overwrites it', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'up4', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Overwrite Test', language: 'en',
    monitored: true, packagingMode: 'chapter',
  });
  const first = await upload(s.id, { chapterNumber: '1' }, [
    { filename: 'issue1.cbz', buf: makeCbzBuffer(['a.jpg']) },
  ]);
  const firstPath = first.json().path;

  const second = await upload(s.id, { chapterNumber: '1' }, [
    { filename: 'issue1-v2.cbz', buf: makeCbzBuffer(['a.jpg', 'b.jpg', 'c.jpg']) },
  ]);
  assert.equal(second.statusCode, 200, second.body);
  const chapter = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(chapter.pages, 3, 'overwritten with the new upload, not merged with the old one');
  assert.ok(existsSync(firstPath), 'overwrite still produces a valid file at the (same) destination path');
});

test('upload-chapter: validation errors', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'up5', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Validation Test', language: 'en',
    monitored: true, packagingMode: 'chapter',
  });

  const noFiles = await upload(s.id, { chapterNumber: '1' }, []);
  assert.equal(noFiles.statusCode, 400);
  assert.match(noFiles.json().error, /no files uploaded/);

  const noNumber = await upload(s.id, {}, [{ filename: 'x.cbz', buf: makeCbzBuffer(['a.jpg']) }]);
  assert.equal(noNumber.statusCode, 400);
  assert.match(noNumber.json().error, /chapterNumber required/);

  const mixed = await upload(s.id, { chapterNumber: '1' }, [
    { filename: 'x.cbz', buf: makeCbzBuffer(['a.jpg']) },
    { filename: 'p1.jpg', buf: PNG, contentType: 'image/jpeg' },
  ]);
  assert.equal(mixed.statusCode, 400);
  assert.match(mixed.json().error, /cannot mix/);

  const missingSeries = await upload(999999, { chapterNumber: '1' }, [{ filename: 'x.cbz', buf: makeCbzBuffer(['a.jpg']) }]);
  assert.equal(missingSeries.statusCode, 404);
});
