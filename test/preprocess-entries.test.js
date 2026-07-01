import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { buildEntries } from '../src/core/packager.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-ppentries-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const chapDir = path.join(tmp, 'ch1');
mkdirSync(chapDir, { recursive: true });

async function page(name, w, h) {
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .png().toFile(path.join(chapDir, name));
}

test('setup pages', async () => {
  await page('001.png', 800, 1200);  // normal portrait
  await page('002.png', 2400, 1200); // wide spread
});

test('preprocess:null leaves pages untouched (sourcePath from staging)', async () => {
  const entries = await buildEntries(['1'], { 1: chapDir }, {});
  const pages = entries.filter(e => e.archiveName.startsWith('ch'));
  assert.equal(pages.length, 2);
  assert.ok(pages.every(e => e.sourcePath.startsWith(chapDir)), 'entries point at original staging files');
  assert.deepEqual(pages.map(e => e.archiveName), ['ch0001_p001.png', 'ch0001_p002.png']);
});

test('split spread yields contiguous page numbering from a temp workDir', async () => {
  const workDir = path.join(tmp, 'work');
  const entries = await buildEntries(['1'], { 1: chapDir }, {
    preprocess: {
      spread: { enabled: true, mode: 'split', direction: 'rtl' },
      encode: { enabled: true, format: 'jpeg', quality: 85 },
    },
    workDir,
  });
  const pages = entries.filter(e => e.archiveName.startsWith('ch'));
  // page 1 (portrait) -> 1 output; page 2 (spread, split) -> 2 outputs => 3 total
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(e => e.archiveName), ['ch0001_p001.jpg', 'ch0001_p002.jpg', 'ch0001_p003.jpg']);
  assert.ok(pages.every(e => e.sourcePath.startsWith(workDir)), 'processed pages stream from the work dir');
});
