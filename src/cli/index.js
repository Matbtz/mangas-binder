#!/usr/bin/env node
import { createInterface } from 'readline/promises';
import { existsSync } from 'fs';
import { program } from 'commander';
import { searchManga, fetchVolumeMap, fetchMangaDetails, fetchVolumeCovers } from '../providers/mangadex.js';
import { getTotalVolumesForTitle } from '../providers/mangaupdates.js';
import { extrapolateVolumes, getVolumeStats } from '../core/extrapolate.js';
import { scanLocalChapters, matchChapterToVolume } from '../core/scanner.js';
import { buildJob, createCbz, downloadBuffer } from '../core/packager.js';
import { buildComicInfoXml } from '../core/comicinfo.js';

program
  .name('mangas-binder')
  .description('Create CBZ files per volume from local manga chapters using MangaDex + MangaUpdates mapping')
  .requiredOption('-m, --manga <name>', 'Manga title to search')
  .requiredOption('-i, --input <dir>', 'Local directory containing chapter folders')
  .requiredOption('-o, --output <dir>', 'Directory to write CBZ files')
  .option('-r, --refresh', 'Force re-fetch the chapter/volume mapping')
  .option('--skip-unassigned', 'Skip chapters that cannot be assigned to any volume')
  .option('--no-extrapolate', 'Disable extrapolation for unassigned chapters')
  .option('--no-metadata', 'Skip adding ComicInfo.xml and cover image to CBZ files');

program.parse();
const opts = program.opts();

if (!existsSync(opts.input)) {
  console.error(`Input directory not found: ${opts.input}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function pickManga(title) {
  console.log(`\nSearching MangaDex for "${title}"...`);
  const results = await searchManga(title);
  if (results.length === 0) {
    console.error('No results found on MangaDex.');
    process.exit(1);
  }
  if (results.length === 1) {
    console.log(`  Found: ${results[0].title} (${results[0].id})`);
    return results[0];
  }
  console.log('\nMultiple results found:');
  results.forEach((r, i) => console.log(`  [${i + 1}] ${r.title}`));
  const answer = await rl.question('Pick a number (or Enter for #1): ');
  const idx = parseInt(answer, 10);
  return results[isNaN(idx) || idx < 1 || idx > results.length ? 0 : idx - 1];
}

function progressBar(current, total, width = 20) {
  const filled = Math.round((current / total) * width);
  const bar = '='.repeat(filled) + ' '.repeat(width - filled);
  return `[${bar}] ${current}/${total}`;
}

async function processVolumes(volumes, byVolume, localChapters, mangaTitle, mangaId, isCalculated, mangaDetails, coverMap) {
  let created = 0;
  let totalSize = 0;

  for (const vol of volumes) {
    const label = vol === 'none'
      ? 'Volume not released'
      : isCalculated
        ? `Vol ${vol} (calculated)`
        : `Vol ${vol}`;

    const chapters = byVolume[vol];

    // Fetch cover
    let coverBuffer = null;
    if (opts.metadata !== false && vol !== 'none') {
      const coverUrl = coverMap?.get(String(parseFloat(vol)));
      if (coverUrl) {
        process.stdout.write(`  [${label}] Fetching cover...\r`);
        coverBuffer = await downloadBuffer(coverUrl);
      }
    }

    // Build ComicInfo.xml
    let comicInfoXml = null;
    if (opts.metadata !== false) {
      comicInfoXml = buildComicInfoXml({
        series: mangaTitle,
        volumeNum: vol === 'none' ? '' : vol,
        authors: mangaDetails?.authors || [],
        artists: mangaDetails?.artists || [],
        description: mangaDetails?.description || '',
        genres: mangaDetails?.genres || [],
        year: mangaDetails?.year,
        mangadexId: mangaId,
        isCalculated: isCalculated && vol !== 'none',
      });
    }

    const job = await buildJob(vol, chapters, localChapters, opts.output, mangaTitle, isCalculated && vol !== 'none', comicInfoXml, coverBuffer);

    if (job.entries.filter(e => e.sourcePath).length === 0) {
      console.log(`  [${label}] No images found, skipping.`);
      continue;
    }

    process.stdout.write(`  [${label}] ${progressBar(0, job.entries.length)}\r`);

    await createCbz(job, ({ current, total }) => {
      process.stdout.write(`  [${label}] ${progressBar(current, total)}\r`);
    });

    const { statSync } = await import('fs');
    const size = statSync(job.outputPath).size;
    totalSize += size;
    const coverTag = coverBuffer ? ' +cover' : '';
    const metaTag = comicInfoXml ? ' +meta' : '';
    console.log(`  [${label}] Done - ${job.entries.filter(e => e.sourcePath).length} pages${coverTag}${metaTag}, ${(size / 1024 / 1024).toFixed(1)} MB`);
    created++;
  }

  return { created, totalSize };
}

async function main() {
  const manga = await pickManga(opts.manga);
  console.log(`\nUsing: ${manga.title}`);

  // --- Fetch manga details (author, genres, description) ---
  let mangaDetails = null;
  let coverMap = new Map();
  if (opts.metadata !== false) {
    process.stdout.write('  Fetching manga details (author, genres)...');
    try {
      mangaDetails = await fetchMangaDetails(manga.id);
      console.log(` ${mangaDetails.authors.join(', ')} — ${mangaDetails.genres.slice(0, 3).join(', ')}`);
    } catch {
      console.log(' failed, continuing without metadata.');
    }

    process.stdout.write('  Fetching volume covers...');
    try {
      coverMap = await fetchVolumeCovers(manga.id);
      console.log(` ${coverMap.size} covers found`);
    } catch {
      console.log(' failed, continuing without covers.');
    }
  }

  // --- Pass 1+2: MangaDex (aggregate + feed) ---
  console.log('\nFetching volume/chapter mapping from MangaDex...');
  const volumeMap = await fetchVolumeMap(manga.id, opts.output, opts.refresh);
  const volumeCount = Object.keys(volumeMap).filter(v => v !== 'none').length;
  console.log(`  ${volumeCount} volumes found on MangaDex`);

  // --- Pass 3: MangaUpdates for total volume count ---
  let totalVolumesHint = null;
  const noneCount = (volumeMap['none'] || []).length;
  if (noneCount > 0 && opts.extrapolate !== false) {
    process.stdout.write('  Checking MangaUpdates for total volume count...');
    try {
      const mu = await getTotalVolumesForTitle(opts.manga);
      if (mu?.totalVolumes) {
        totalVolumesHint = mu.totalVolumes;
        console.log(` ${totalVolumesHint} volumes total (${mu.seriesTitle})`);
      } else {
        console.log(' not found.');
      }
    } catch {
      console.log(' unavailable.');
    }
  }

  // --- Scan local chapters ---
  console.log(`\nScanning local chapters in: ${opts.input}`);
  const localChapters = await scanLocalChapters(opts.input);
  console.log(`  ${Object.keys(localChapters).length} chapter folders found`);

  const { matched, unmatched, missing } = matchChapterToVolume(localChapters, volumeMap);

  if (missing.length > 0) {
    console.log(`\nWARN: ${missing.length} MangaDex chapters not found locally (skipped):`);
    console.log(`  ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`);
  }

  // Group confirmed volumes
  const byVolume = {};
  for (const { volume, chapterNum } of matched) {
    if (!byVolume[volume]) byVolume[volume] = [];
    byVolume[volume].push(chapterNum);
  }

  // Detect sparse outlier volumes: non-consecutive MangaDex entries with far fewer
  // chapters than the average (e.g. a single bonus chapter tagged as "volume 23").
  // Move their chapters into the unassigned pool so extrapolation handles them.
  const { consecutiveVolSet, avgChsPerVol } = getVolumeStats(volumeMap);
  const sparseChapters = [];
  for (const volKey of Object.keys(byVolume)) {
    if (volKey === 'none') continue;
    if (!consecutiveVolSet.has(volKey) && byVolume[volKey].length < Math.ceil(avgChsPerVol / 2)) {
      sparseChapters.push(...byVolume[volKey]);
      delete byVolume[volKey];
    }
  }
  if (sparseChapters.length > 0) {
    console.log(`\n  Moved ${sparseChapters.length} sparse outlier chapter(s) to unassigned pool (MangaDex tagging issue)`);
  }

  // All unassigned local chapters
  const unassigned = [
    ...(byVolume['none'] || []),
    ...unmatched,
    ...sparseChapters,
  ];
  delete byVolume['none']; // will be rebuilt below if needed

  // --- Pass 4: Extrapolation ---
  let calculatedVolumes = {};
  if (unassigned.length > 0 && !opts.skipUnassigned && opts.extrapolate !== false) {
    const { calculated, overflow } = extrapolateVolumes(volumeMap, unassigned, totalVolumesHint, false);
    calculatedVolumes = calculated;
    const calcCount = Object.keys(calculatedVolumes).length;
    if (calcCount > 0) {
      const hint = totalVolumesHint
        ? ` (based on ${totalVolumesHint} total volumes from MangaUpdates)`
        : ' (based on avg chapters/volume)';
      console.log(`\n  Extrapolated ${calcCount} calculated volumes${hint}`);
    }
    if (overflow.length > 0) {
      byVolume['none'] = overflow;
      console.log(`  ${overflow.length} chapters beyond volume ${totalVolumesHint ?? '?'} -> "Volume not released"`);
    }
  } else if (unassigned.length > 0 && !opts.skipUnassigned) {
    byVolume['none'] = unassigned;
  }

  // --- Build volume lists ---
  const confirmedVols = Object.keys(byVolume)
    .filter(v => v !== 'none')
    .sort((a, b) => parseFloat(a) - parseFloat(b));

  const calcVols = Object.keys(calculatedVolumes)
    .sort((a, b) => parseFloat(a) - parseFloat(b));

  const totalCbz = confirmedVols.length + calcVols.length + (byVolume['none'] ? 1 : 0);
  console.log(`\nCreating ${totalCbz} CBZ file(s)...\n`);

  const r1 = await processVolumes(confirmedVols, byVolume, localChapters, manga.title, manga.id, false, mangaDetails, coverMap);
  const r2 = await processVolumes(calcVols, calculatedVolumes, localChapters, manga.title, manga.id, true, mangaDetails, coverMap);

  let r3 = { created: 0, totalSize: 0 };
  if (byVolume['none']?.length > 0) {
    r3 = await processVolumes(['none'], byVolume, localChapters, manga.title, manga.id, false, mangaDetails, coverMap);
  }

  const totalCreated = r1.created + r2.created + r3.created;
  const totalSize = r1.totalSize + r2.totalSize + r3.totalSize;
  console.log(`\nDone. ${totalCreated} CBZ file(s) created, total ${(totalSize / 1024 / 1024).toFixed(1)} MB.`);
  rl.close();
}

main().catch(err => {
  console.error('\nError:', err.message);
  rl.close();
  process.exit(1);
});
