import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { processPage, isNoop } from '../src/core/image-preprocess.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-imgproc-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

async function makeImage(name, width, height, channels = 3) {
  const p = path.join(tmp, name);
  await sharp({ create: { width, height, channels, background: { r: 120, g: 120, b: 120 } } })
    .png()
    .toFile(p);
  return p;
}

test('isNoop: all-disabled config is a no-op', () => {
  assert.equal(isNoop(null), true);
  assert.equal(isNoop({ resize: { enabled: false }, gamma: { enabled: false } }), true);
  assert.equal(isNoop({ resize: { enabled: true, width: 100, height: 100 } }), false);
});

test('portrait page: resized within device bounds, grayscale, jpeg', async () => {
  const src = await makeImage('portrait.png', 800, 1200);
  const out = await processPage(src, {
    grayscale: { enabled: true },
    resize: { enabled: true, width: 1404, height: 1872, mode: 'fit', upscale: true },
    encode: { enabled: true, format: 'jpeg', quality: 90 },
  });
  assert.equal(out.length, 1);
  const meta = await sharp(out[0].buffer).metadata();
  assert.equal(out[0].ext, '.jpg');
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.channels, 1, 'grayscale => single channel');
  // Aspect preserved (2:3), scaled up to the 1872 height bound.
  assert.equal(meta.height, 1872);
  assert.equal(meta.width, 1248);
});

test('wide spread + rotate: becomes a single portrait page fitting the device', async () => {
  const src = await makeImage('spread.png', 2400, 1200);
  const out = await processPage(src, {
    spread: { enabled: true, mode: 'rotate', direction: 'rtl' },
    resize: { enabled: true, width: 1404, height: 1872, mode: 'fit', upscale: true },
    encode: { enabled: true, format: 'jpeg', quality: 90 },
  });
  assert.equal(out.length, 1, 'rotate yields one page');
  const meta = await sharp(out[0].buffer).metadata();
  // Rotated 2400x1200 -> 1200x2400 (tall), then fit inside 1404x1872 by height.
  assert.ok(meta.height > meta.width, 'rotated spread is portrait-shaped');
  assert.equal(meta.height, 1872);
});

test('wide spread + split: becomes two pages, each ~half width', async () => {
  const src = await makeImage('spread2.png', 2400, 1200);
  const out = await processPage(src, {
    spread: { enabled: true, mode: 'split', direction: 'rtl' },
    resize: { enabled: false },
    encode: { enabled: true, format: 'jpeg', quality: 90 },
  });
  assert.equal(out.length, 2, 'split yields two pages');
  for (const o of out) {
    const meta = await sharp(o.buffer).metadata();
    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 1200);
  }
});

test('tall page is not treated as a spread', async () => {
  const src = await makeImage('tall.png', 1000, 1500);
  const out = await processPage(src, {
    spread: { enabled: true, mode: 'split', direction: 'rtl' },
    encode: { enabled: true, format: 'keep', quality: 90 },
  });
  assert.equal(out.length, 1, 'non-wide page is left as a single page');
});

test('encode keep preserves PNG', async () => {
  const src = await makeImage('keep.png', 400, 600);
  const out = await processPage(src, {
    grayscale: { enabled: true },
    encode: { enabled: true, format: 'keep', quality: 90 },
  });
  assert.equal(out[0].ext, '.png');
  const meta = await sharp(out[0].buffer).metadata();
  assert.equal(meta.format, 'png');
});
