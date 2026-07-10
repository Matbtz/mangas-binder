import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Regression coverage for POST /series/:id/upload-volume — manually uploading a
// whole VOLUME archive. Two behaviors requested explicitly by the user:
//   1) A folder-per-chapter layout inside the archive gets split into individual
//      chapters (same staging pipeline as upload-chapter, one call per folder).
//   2) A flat archive (no chapter-boundary signal) is kept as-is and linked
//      directly to every chapter already tracked under that volume — mirrors the
//      library scanner's own convention for a foreign whole-volume CBZ.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-upload-vol-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { setSetting } = await import('../src/core/settings.js');
const { createSeries, listChaptersForSeries, upsertChapter, setChapterState } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
setSetting('downloadsPaused', true);
after(async () => { await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

function makeZip(entries) {
  const z = new AdmZip();
  for (const name of entries) z.addFile(name, PNG);
  return z.toBuffer();
}

function buildMultipart(fields = {}, files = []) {
  const boundary = 'mbTestBoundaryVol123';
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

async function uploadVolume(seriesId, fields, files) {
  const { payload, boundary } = buildMultipart(fields, files);
  return app.inject({
    method: 'POST',
    url: `/api/series/${seriesId}/upload-volume`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

test('upload-volume: folder-per-chapter archive splits into individual chapters (chapter-packaging series)', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'uv1', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Volume Split Test', language: 'en',
    monitored: true, packagingMode: 'chapter',
  });
  const zip = makeZip(['Chapter 15/001.jpg', 'Chapter 15/002.jpg', 'Chapter 16/001.jpg']);
  const res = await uploadVolume(s.id, { volume: '3' }, [{ filename: 'vol3.cbz', buf: zip }]);

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'hierarchical');
  assert.deepEqual(body.chapters.sort(), ['15', '16']);
  assert.equal(body.paths.length, 2);
  for (const p of body.paths) assert.ok(existsSync(p));

  const chapters = listChaptersForSeries(s.id);
  const ch15 = chapters.find(c => c.number === '15');
  const ch16 = chapters.find(c => c.number === '16');
  assert.equal(ch15.volume, '3');
  assert.equal(ch16.volume, '3');
  assert.equal(ch15.state, 'bindery');
  assert.equal(ch16.state, 'bindery');
  assert.equal(ch15.pages, 2);
  assert.equal(ch16.pages, 1);
});

test('upload-volume: folder-per-chapter with an outer wrapping folder still splits, and packages a completed volume in one shot', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'uv2', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Volume Nested Test', language: 'en',
    monitored: true, packagingMode: 'volume', status: 'completed',
  });
  const zip = makeZip(['MyVol/Chapter 1/a.jpg', 'MyVol/Chapter 2/a.jpg']);
  const res = await uploadVolume(s.id, { volume: '1' }, [{ filename: 'vol1.cbz', buf: zip }]);

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.mode, 'hierarchical');
  assert.deepEqual(body.chapters.sort(), ['1', '2']);
  assert.equal(body.importedVolumes, 1, 'the now-complete volume packaged in one shot');

  const chapters = listChaptersForSeries(s.id);
  const ch1 = chapters.find(c => c.number === '1');
  const ch2 = chapters.find(c => c.number === '2');
  assert.equal(ch1.state, 'bindery');
  assert.equal(ch2.state, 'bindery');
  assert.equal(ch1.cbz_path, ch2.cbz_path, 'both chapters packaged into the same volume CBZ');
});

test('upload-volume: flat archive is linked as-is to already-tracked chapters (no page splitting)', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'uv3', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Volume Flat Test', language: 'en',
    monitored: true, packagingMode: 'volume',
  });
  upsertChapter(s.id, { provider: 'manual', number: '20', volume: '5' }, 'wanted');
  upsertChapter(s.id, { provider: 'manual', number: '21', volume: '5' }, 'wanted');

  const zipBuf = makeZip(['001.jpg', '002.jpg', '003.jpg']); // flat, no chapter folders
  const res = await uploadVolume(s.id, { volume: '5' }, [{ filename: 'vol5.cbz', buf: zipBuf }]);

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.mode, 'flat');
  assert.deepEqual(body.linkedChapters.sort(), ['20', '21']);
  assert.ok(existsSync(body.path));
  // The file on disk must be byte-identical to what was uploaded — not repackaged.
  assert.ok(readFileSync(body.path).equals(zipBuf), 'flat volume file is kept as-is, not rebuilt');

  const chapters = listChaptersForSeries(s.id);
  const ch20 = chapters.find(c => c.number === '20');
  const ch21 = chapters.find(c => c.number === '21');
  assert.equal(ch20.state, 'bindery');
  assert.equal(ch21.state, 'bindery');
  assert.equal(ch20.cbz_path, body.path);
  assert.equal(ch21.cbz_path, body.path);
  assert.equal(ch20.staging_path, null, 'no staging happened for the flat link case');
});

test('upload-volume: flat archive with no chapters tracked under that volume fails clearly', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'uv4', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Volume No Chapters Test', language: 'en',
    monitored: true, packagingMode: 'volume',
  });
  const zipBuf = makeZip(['001.jpg']);
  const res = await uploadVolume(s.id, { volume: '9' }, [{ filename: 'vol9.cbz', buf: zipBuf }]);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /No chapters are tracked for volume 9/);
});

test('upload-volume: an unparseable chapter-folder name fails atomically (nothing staged)', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'uv5', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Volume Bad Folder Test', language: 'en',
    monitored: true, packagingMode: 'chapter',
  });
  const zip = makeZip(['Chapter 15/a.jpg', 'BonusStuff/a.jpg']);
  const res = await uploadVolume(s.id, { volume: '1' }, [{ filename: 'vol1.cbz', buf: zip }]);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /BonusStuff/);
  assert.equal(listChaptersForSeries(s.id).length, 0, 'nothing staged/created on a resolution failure');
});

test('upload-volume: validation errors', async () => {
  const s = createSeries({
    provider: 'comicvine', providerSeriesId: 'uv6', mediaType: 'comic',
    downloadProvider: 'getcomics', title: 'Upload Volume Validation Test', language: 'en',
    monitored: true, packagingMode: 'chapter',
  });
  const noVolume = await uploadVolume(s.id, {}, [{ filename: 'v.cbz', buf: makeZip(['a.jpg']) }]);
  assert.equal(noVolume.statusCode, 400);
  assert.match(noVolume.json().error, /volume required/);

  const noFiles = await uploadVolume(s.id, { volume: '1' }, []);
  assert.equal(noFiles.statusCode, 400);
  assert.match(noFiles.json().error, /archive is required/);

  const twoArchives = await uploadVolume(s.id, { volume: '1' }, [
    { filename: 'a.cbz', buf: makeZip(['a.jpg']) },
    { filename: 'b.cbz', buf: makeZip(['a.jpg']) },
  ]);
  assert.equal(twoArchives.statusCode, 400);
  assert.match(twoArchives.json().error, /only one archive/);

  const missingSeries = await uploadVolume(999999, { volume: '1' }, [{ filename: 'v.cbz', buf: makeZip(['a.jpg']) }]);
  assert.equal(missingSeries.statusCode, 404);
});
