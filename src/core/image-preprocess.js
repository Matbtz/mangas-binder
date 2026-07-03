import sharp from 'sharp';

/**
 * KCC-style page treatment applied just before packaging. A "profile config"
 * groups independent treatment blocks, each with its own `enabled` flag and
 * custom values:
 *
 *   {
 *     grayscale:    { enabled },
 *     autocontrast: { enabled, blackPoint },        // 0..100 shadow lift
 *     gamma:        { enabled, value },              // 1.0..3.0 (>1 brightens)
 *     crop:         { enabled, power, preserveMarginPct },
 *     spread:       { enabled, mode:'rotate'|'split', direction:'rtl'|'ltr' },
 *     resize:       { enabled, width, height, mode:'fit'|'stretch', upscale },
 *     encode:       { enabled, format:'jpeg'|'keep', quality },
 *   }
 *
 * Only the blocks that are enabled do anything; a config with nothing enabled
 * is a no-op (see `isNoop`) and callers skip it entirely.
 */

const BLOCKS = ['grayscale', 'autocontrast', 'gamma', 'crop', 'spread', 'resize', 'encode'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** True when no treatment block is enabled — caller can pack pages untouched. */
export function isNoop(cfg) {
  if (!cfg) return true;
  return !BLOCKS.some(b => cfg[b] && cfg[b].enabled);
}

/**
 * Human-readable list of the treatment blocks a config has active, for activity
 * logs. Mirrors the same clamp/fallback math `runPipeline` actually applies
 * (not just the raw stored value) so the log can't claim a setting that isn't
 * really what gets used — e.g. a stray `power: 0` really runs as `power: 1`.
 */
export function describeConfig(cfg) {
  if (!cfg) return [];
  const parts = [];
  if (cfg.grayscale?.enabled) parts.push('grayscale');
  if (cfg.autocontrast?.enabled) {
    const bp = clamp(Number(cfg.autocontrast.blackPoint) || 0, 0, 100);
    parts.push(`autocontrast(blackPoint=${bp})`);
  }
  if (cfg.gamma?.enabled) {
    const g = clamp(Number(cfg.gamma.value) || 1, 1, 3);
    parts.push(`gamma(${g})`);
  }
  if (cfg.crop?.enabled) {
    const power = clamp(Number(cfg.crop.power) || 1, 0.1, 5);
    const pct = clamp(Number(cfg.crop.preserveMarginPct) || 0, 0, 100);
    parts.push(`crop(power=${power}, margin=${pct}%)`);
  }
  if (cfg.spread?.enabled) parts.push(`spread(${cfg.spread.mode || 'rotate'}/${cfg.spread.direction || 'rtl'})`);
  if (cfg.resize?.enabled) {
    parts.push(`resize(${cfg.resize.width}x${cfg.resize.height} ${cfg.resize.mode || 'fit'}${cfg.resize.upscale ? '+upscale' : ''})`);
  }
  if (cfg.encode?.enabled) {
    const fmt = cfg.encode.format || 'jpeg';
    const quality = clamp(Math.round(cfg.encode.quality ?? 90), 1, 100);
    parts.push(fmt === 'jpeg' ? `encode(jpeg q${quality})` : `encode(${fmt})`);
  }
  return parts;
}

function extForFormat(format) {
  switch (format) {
    case 'png': return '.png';
    case 'webp': return '.webp';
    case 'gif': return '.png'; // sharp flattens animation; emit a still PNG
    case 'avif': return '.avif';
    default: return '.jpg';
  }
}

/** Apply the chosen encoder and return { buffer, ext }. */
async function encode(pipe, encodeCfg, srcFormat) {
  const jpeg = encodeCfg?.enabled && encodeCfg.format === 'jpeg';
  if (jpeg) {
    const quality = clamp(Math.round(encodeCfg.quality ?? 90), 1, 100);
    const buffer = await pipe.jpeg({ quality }).toBuffer();
    return { buffer, ext: '.jpg' };
  }
  // Keep source format (re-encode is unavoidable once decoded); default to jpeg
  // for formats sharp can't losslessly round-trip cheaply.
  const fmt = ['png', 'webp', 'jpeg', 'jpg', 'avif'].includes(srcFormat) ? srcFormat : 'jpeg';
  const outFmt = fmt === 'jpg' ? 'jpeg' : fmt;
  const buffer = await pipe.toFormat(outFmt).toBuffer();
  return { buffer, ext: extForFormat(outFmt) };
}

/**
 * Run the tonal → crop → resize → encode chain on a single sharp source.
 * `target` is the { width, height } bounds for the resize step.
 */
async function runPipeline(makeSource, cfg, target) {
  let pipe = makeSource();

  // toColourspace('b-w') forces a genuine single-channel output (grayscale()
  // alone still writes a 3-channel JPEG), which halves e-ink file size.
  if (cfg.grayscale?.enabled) pipe = pipe.grayscale().toColourspace('b-w');

  if (cfg.autocontrast?.enabled) {
    pipe = pipe.normalize();
    const bp = clamp(Number(cfg.autocontrast.blackPoint) || 0, 0, 100);
    // Lift the black point: map [bp,255] -> [0,255] so the darkest tones clip to
    // solid black (KCC's "black point" / extreme-contrast behaviour).
    if (bp > 0) {
      const scale = 255 / (255 - (bp * 255 / 100));
      pipe = pipe.linear(scale, -(bp * 255 / 100) * scale);
    }
  }

  if (cfg.gamma?.enabled) {
    const g = clamp(Number(cfg.gamma.value) || 1, 1, 3);
    // gamma(1.0, g) applies output-gamma encoding only (out = in^(1/g)), which
    // brightens midtones/shadows for g>1 — the KCC-style lift the profile intends.
    // Single-arg sharp.gamma(g) linearises then re-encodes with the same value, so
    // it is tonally a no-op (a flat mid-gray stays put) and must not be used here.
    if (g !== 1) pipe = pipe.gamma(1.0, g);
  }

  if (cfg.crop?.enabled) {
    // Higher power => more aggressive margin removal (higher trim threshold).
    const power = clamp(Number(cfg.crop.power) || 1, 0.1, 5);
    const threshold = clamp(Math.round(10 * power), 1, 100);
    pipe = pipe.trim({ threshold });
    const pct = clamp(Number(cfg.crop.preserveMarginPct) || 0, 0, 100);
    if (pct > 0) {
      // Re-add a margin as a percentage of the trimmed dimensions.
      const buf = await pipe.toBuffer();
      const m = await sharp(buf).metadata();
      const mx = Math.round((m.width || 0) * pct / 100);
      const my = Math.round((m.height || 0) * pct / 100);
      // Materialise the extend to a buffer and re-open it as the new pipeline
      // baseline. Within a single sharp pipeline, resize is always applied before
      // extend regardless of call order, so a later .resize() would run on the
      // un-extended raster and the re-added margin would then push the page back
      // over the device bounds (the resize step ends up a no-op). Flushing here
      // guarantees the subsequent resize sees the already-extended image.
      const extended = await sharp(buf).extend({
        top: my, bottom: my, left: mx, right: mx,
        background: cfg.grayscale?.enabled ? '#ffffff' : { r: 255, g: 255, b: 255 },
      }).toBuffer();
      pipe = sharp(extended);
    }
  }

  if (cfg.resize?.enabled && target) {
    const stretch = cfg.resize.mode === 'stretch';
    pipe = pipe.resize(target.width, target.height, {
      fit: stretch ? 'fill' : 'inside',
      withoutEnlargement: !cfg.resize.upscale,
    });
  }

  return encode(pipe, cfg.encode, cfg._srcFormat);
}

/**
 * Process one staged page. Returns an array of processed images:
 *   - normally a single image,
 *   - two images when a wide (double-page) spread is split.
 * @param {string} srcPath  path to a staged page image on disk
 * @param {object} cfg      profile config (see module docblock)
 * @returns {Promise<Array<{ buffer: Buffer, ext: string }>>}
 */
export async function processPage(srcPath, cfg) {
  const meta = await sharp(srcPath, { failOn: 'none' }).metadata();
  cfg = { ...cfg, _srcFormat: meta.format };
  const width = meta.width || 0;
  const height = meta.height || 0;
  const isWide = width > 0 && height > 0 && width > height;

  const spread = cfg.spread;
  const rtl = (spread?.direction || 'rtl') === 'rtl';
  const doSplit = spread?.enabled && isWide && spread.mode === 'split';
  const doRotate = spread?.enabled && isWide && spread.mode === 'rotate';

  // Resize bounds are always the (portrait) device dimensions. A rotated spread
  // becomes portrait-shaped (a wide page turned 90° is now tall), so it fits the
  // same portrait screen — the reader turns the device to view it full-size.
  const rw = cfg.resize?.width, rh = cfg.resize?.height;
  const target = rw && rh ? { width: rw, height: rh } : null;

  if (doSplit) {
    const halfW = Math.floor(width / 2);
    const leftSrc = () => sharp(srcPath, { failOn: 'none' })
      .extract({ left: 0, top: 0, width: halfW, height });
    const rightSrc = () => sharp(srcPath, { failOn: 'none' })
      .extract({ left: width - halfW, top: 0, width: halfW, height });
    // Right-to-left manga: the right half is the earlier page.
    const ordered = rtl ? [rightSrc, leftSrc] : [leftSrc, rightSrc];
    const out = [];
    for (const src of ordered) out.push(await runPipeline(src, cfg, target));
    return out;
  }

  const makeSource = () => {
    let s = sharp(srcPath, { failOn: 'none' });
    if (doRotate) s = s.rotate(rtl ? 90 : 270);
    return s;
  };
  return [await runPipeline(makeSource, cfg, target)];
}
