import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression: a volume-release CBZ whose name uses the short "vNN" form and
// repeats its own number ("ONE PIECE 85 v85.cbz" = volume 85) used to fall
// through the linked-folder scan's volume matching (which only understood the
// long "Vol. NN" form) into the bare chapter-number fallback, marking *chapter*
// 85 as owned by a file that is actually volume 85. Conversely, a chapter
// release with a version tag ("Series 985 v2.cbz" = chapter 985, revision 2)
// used to be read as volume 2.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-vollink-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { ensureSeeded } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries } = await import('../src/core/repo.js');
const { scanLibrary, readCbzInfo } = await import('../src/core/library-scan.js');
const { closeDb } = await import('../src/core/db.js');

ensureSeeded();
after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

async function makeCbz(dir, name) {
  const AdmZip = (await import('adm-zip')).default;
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const zip = new AdmZip();
  zip.addFile('page001.jpg', PNG);
  zip.writeZip(p);
  return p;
}

test('readCbzInfo disambiguates short vNN form: volume when numbers agree, version tag otherwise', async () => {
  const dir = path.join(tmp, 'parse');
  const volFile = await makeCbz(dir, 'ONE PIECE 85 v85.cbz');
  assert.equal((await readCbzInfo(volFile)).volume, '85', 'repeated number → volume release');

  // Real One Piece library naming: a big vNN is a volume even next to an
  // unrelated (collection/reading-order) leading number.
  const stray1 = await makeCbz(dir, 'ONE PIECE 1 v84.cbz');
  assert.equal((await readCbzInfo(stray1)).volume, '84', '"1 v84" → volume 84, not chapter 1');
  const stray3 = await makeCbz(dir, 'ONE PIECE 3 v87.cbz');
  assert.equal((await readCbzInfo(stray3)).volume, '87', '"3 v87" → volume 87, not chapter 3');
  const titled = await makeCbz(dir, "One Piece A Genius's Dream v106 (2).cbz");
  assert.equal((await readCbzInfo(titled)).volume, '106', 'titled volume with (2) copy suffix → volume 106');

  // A *small* vNN next to a larger number is a scanlation version tag.
  const chFile = await makeCbz(dir, 'Some Series 985 (digital) (v2).cbz');
  assert.equal((await readCbzInfo(chFile)).volume, null, 'small vN next to a larger chapter number → version tag, not a volume');
  const chFile2 = await makeCbz(dir, 'One Piece 985 v2.cbz');
  assert.equal((await readCbzInfo(chFile2)).volume, null, 'non-parenthesised "985 v2" → chapter 985 version 2, not volume 2');

  const plainVol = await makeCbz(dir, 'Some Series v07.cbz');
  assert.equal((await readCbzInfo(plainVol)).volume, '7', 'lone vNN → volume');

  const longForm = await makeCbz(dir, 'Some Series Vol. 03.cbz');
  assert.equal((await readCbzInfo(longForm)).volume, '3', 'long form always wins');
});

test('reproduces the reported bug: "ONE PIECE 3 v87.cbz" must not link to chapter 3', async () => {
  // Exact scenario from the delete-files screenshot: a linked /books folder of
  // One Piece volume releases named "ONE PIECE <n> v<vol>.cbz". Each is a
  // volume; none of the leading numbers are chapters.
  const customDir = path.join(tmp, 'reported', 'One Piece');
  await makeCbz(customDir, 'ONE PIECE 1 v84.cbz');
  await makeCbz(customDir, 'ONE PIECE 3 v87.cbz');
  await makeCbz(customDir, 'ONE PIECE 4 v91.cbz');
  await makeCbz(customDir, 'ONE PIECE 7 v78.cbz');

  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'vl-report', title: 'One Piece',
    language: 'en', monitored: true, packagingMode: 'volume', folderPath: customDir,
  });
  // Volume 1's early chapters (the ones wrongly deleted in the screenshot).
  for (const n of ['1', '2', '3', '4', '7']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  // Chapters actually belonging to the volumes on disk.
  upsertChapter(s.id, { provider: 'mangadex', number: '827', volume: '84' });
  upsertChapter(s.id, { provider: 'mangadex', number: '873', volume: '87' });

  await scanLibrary({ seriesId: s.id });

  const chs = listChaptersForSeries(s.id);
  for (const n of ['1', '2', '3', '4', '7']) {
    const c = chs.find(x => x.number === n);
    assert.notEqual(c.state, 'imported', `volume-1 chapter ${n} must NOT be linked to a v84/v87/... volume file`);
    assert.equal(c.cbz_path, null, `chapter ${n} keeps no bogus cbz_path`);
  }
  // The volume files did land on their real volumes' chapters.
  assert.equal(chs.find(c => c.number === '827').state, 'imported', 'chapter 827 (vol 84) owned via v84 file');
  assert.equal(chs.find(c => c.number === '873').state, 'imported', 'chapter 873 (vol 87) owned via v87 file');
});

test('linked-folder scan matches a "N vN" volume file by volume, never the same-numbered chapter', async () => {
  const customDir = path.join(tmp, 'linked', 'One Piece Test');
  await makeCbz(customDir, 'ONE PIECE TEST 85 v85.cbz');

  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'vl-1', title: 'One Piece Test',
    language: 'en', monitored: true, packagingMode: 'volume', folderPath: customDir,
  });
  // Chapter 85 belongs to volume 10; chapters 848-850 belong to volume 85.
  upsertChapter(s.id, { provider: 'mangadex', number: '85', volume: '10' });
  for (const n of ['848', '849', '850']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '85' });

  await scanLibrary({ seriesId: s.id });

  const chs = listChaptersForSeries(s.id);
  const ch85 = chs.find(c => c.number === '85');
  assert.notEqual(ch85.state, 'imported', 'chapter 85 must NOT be marked owned by the volume-85 file');

  for (const n of ['848', '849', '850']) {
    const c = chs.find(x => x.number === n);
    assert.equal(c.state, 'imported', `chapter ${n} (volume 85) should be marked owned`);
    assert.ok(c.cbz_path.endsWith('ONE PIECE TEST 85 v85.cbz'));
  }
});

test('linked-folder scan still matches a version-tagged chapter file by chapter number', async () => {
  const customDir = path.join(tmp, 'linked2', 'Version Tag Test');
  await makeCbz(customDir, 'Version Tag Test 985 (v2).cbz');

  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'vl-2', title: 'Version Tag Test',
    language: 'en', monitored: true, packagingMode: 'volume', folderPath: customDir,
  });
  upsertChapter(s.id, { provider: 'mangadex', number: '985', volume: '99' });
  // A stray volume-2 chapter that must NOT get claimed by the "v2" version tag.
  upsertChapter(s.id, { provider: 'mangadex', number: '12', volume: '2' });

  await scanLibrary({ seriesId: s.id });

  const chs = listChaptersForSeries(s.id);
  assert.equal(chs.find(c => c.number === '985').state, 'imported', 'chapter 985 owned via its file');
  assert.notEqual(chs.find(c => c.number === '12').state, 'imported', 'volume-2 chapter untouched by the v2 version tag');
});

test('library-dir scan matches a volume-named image folder by volume, not chapter number', async () => {
  const libDir = process.env.OUTPUT_DIR;
  const s = createSeries({
    provider: 'mangadex', providerSeriesId: 'vl-3', title: 'Folder Vol Test',
    language: 'en', monitored: true, packagingMode: 'volume',
  });
  upsertChapter(s.id, { provider: 'mangadex', number: '12', volume: '2' });
  for (const n of ['111', '112'] ) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '12' });

  const { writeFileSync } = await import('node:fs');
  const volDir = path.join(libDir, 'Folder Vol Test', 'Folder Vol Test v12');
  mkdirSync(volDir, { recursive: true });
  writeFileSync(path.join(volDir, '001.png'), PNG);

  await scanLibrary({ seriesId: s.id });

  const chs = listChaptersForSeries(s.id);
  assert.notEqual(chs.find(c => c.number === '12').state, 'imported', 'chapter 12 must not be claimed by the v12 folder');
  for (const n of ['111', '112']) {
    assert.equal(chs.find(c => c.number === n).state, 'imported', `chapter ${n} (volume 12) owned via the v12 folder`);
  }
});
