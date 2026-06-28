import { readdirSync, existsSync, statSync, unlinkSync, rmSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../../core/config.js';
import { getProvider, describeProviders } from '../../providers/index.js';
import { searchManga } from '../../providers/mangadex.js';
import { searchVolumes } from '../../providers/comicvine.js';
import { provider as hardcover } from '../../providers/hardcover.js';
import {
  listSeries, getSeries, updateSeries, deleteSeries,
  listChaptersForSeries, getChapter, setChapterState, bulkSetChapterState,
  listChaptersInStates, recentHistory, listChapterFilesForSeries, resetStaleDownloads,
} from '../../core/repo.js';
import { getDb, logHistory } from '../../core/db.js';
import {
  getAllSettings, getSetting, setSetting, getProviderStates,
  setProviderEnabled, setProviderConfig, getProviderConfig, isProviderEnabled,
} from '../../core/settings.js';
import { followSeries, refreshSeries } from '../../core/series-service.js';
import { scanLibrary, readCbzInfo } from '../../core/library-scan.js';
import { resolveVolumes } from '../../core/mapping.js';
import { getVolumeStats, extrapolateVolumes } from '../../core/extrapolate.js';
import { packageSingleChapter, packageSingleVolume, auditSeriesVolumes } from '../../core/binder.js';
import { runScan, schedulerStatus, startScheduler } from '../../scheduler/scheduler.js';
import { runOnce, cancelChapter, cancelSeries, resetStaleIfIdle, abortStuckInFlight, isRunning } from '../../download/worker.js';
import { notify } from '../../core/notify.js';
import { bus } from '../../core/events.js';
import { seriesView, chapterView } from '../views.js';
import { normTitle, titlesMatch } from '../../core/library.js';

const ACTIVE_STATES = ['wanted', 'queued', 'downloading', 'downloaded', 'failed'];

/** Fastify plugin: all /api routes. */
export default async function apiRoutes(app) {
  // --- Health / status ---
  app.get('/api/health', async () => {
    const db = getDb();
    const seriesCount = db.prepare('SELECT COUNT(*) n FROM series').get().n;
    const byState = db.prepare('SELECT state, COUNT(*) n FROM chapters GROUP BY state').all();
    return {
      ok: true, seriesCount,
      chapters: Object.fromEntries(byState.map(r => [r.state, r.n])),
      scheduler: schedulerStatus(),
      downloadsPaused: !!getSetting('downloadsPaused', false),
    };
  });

  // --- Live updates (Server-Sent Events) ---
  // One stream per connected UI; the frontend re-fetches on a message instead of
  // polling on a fixed 2s timer. EventSource can't set headers, so auth (when
  // enabled) rides on ?token=, which the onRequest hook already accepts.
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let a reverse proxy buffer the stream
    });
    res.write('retry: 3000\n\n');
    const onEvent = (e) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* client gone */ } };
    bus.on('event', onEvent);
    const keepAlive = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
    const cleanup = () => { clearInterval(keepAlive); bus.off('event', onEvent); };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // --- Search a source ---
  app.get('/api/search', async (req, reply) => {
    const { q, provider: name = 'mangadex' } = req.query;
    if (!q) return reply.code(400).send({ error: 'q is required' });
    if (!isProviderEnabled(name)) return reply.code(400).send({ error: `Provider ${name} disabled` });
    const provider = getProvider(name);
    const results = await provider.search(q);
    return { provider: name, results };
  });

  // --- Series CRUD ---
  app.get('/api/series', async () => listSeries().map(s => seriesView(s)));

  app.post('/api/series', async (req, reply) => {
    const { provider = 'mangadex', providerSeriesId, monitorMode, monitorFromVolume, packagingMode, language } = req.body || {};
    if (!providerSeriesId) return reply.code(400).send({ error: 'providerSeriesId is required' });
    const series = await followSeries(provider, providerSeriesId, { monitorMode, monitorFromVolume, packagingMode, language });
    return reply.code(201).send(seriesView(series));
  });

  app.get('/api/series/:id', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return { ...seriesView(s), chapters: listChaptersForSeries(s.id).map(chapterView) };
  });

  app.get('/api/series/:id/cover', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s || !s.cover_path) return reply.code(404).send({ error: 'not found' });

    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' };
    if (s.cover_path.includes('mangadex.org')) {
      headers.Referer = 'https://mangadex.org/';
    } else if (s.cover_path.includes('comicvine')) {
      headers.Referer = 'https://comicvine.gamespot.com/';
    }

    try {
      const res = await fetch(s.cover_path, { headers });
      if (!res.ok) {
        return reply.redirect(s.cover_path);
      }
      reply.header('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=86400');
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return reply.redirect(s.cover_path);
    }
  });


  app.post('/api/series/:id/external-links', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const series = getSeries(id);
    if (!series) return reply.code(404).send({ error: 'Series not found' });
    updateSeries(id, { externalLinks: req.body });
    logHistory('links_updated', { seriesId: id, message: 'Updated external download links' });
    return { success: true };
  });

  app.post('/api/series/:id/hardcover-cover', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const series = getSeries(id);
    if (!series) return reply.code(404).send({ error: 'Series not found' });
    const { title } = req.body;
    if (!title) return reply.code(400).send({ error: 'Title required' });

    try {
      const q = `query($title: String!) { mangas(where: {title: {_ilike: $title}}, limit: 1) { image { url } } }`;
      const resp = await fetch('https://api.hardcover.app/v1/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': process.env.HARDCOVER_API_KEY ? `Bearer ${process.env.HARDCOVER_API_KEY}` : '' },
        body: JSON.stringify({ query: q, variables: { title: `%${title}%` } })
      });
      const data = await resp.json();
      const coverUrl = data?.data?.mangas?.[0]?.image?.url;
      if (coverUrl) {
        updateSeries(id, { coverPath: coverUrl });
        logHistory('cover_updated', { seriesId: id, message: 'Fetched cover from Hardcover' });
        return { success: true, coverUrl };
      } else {
        return reply.code(404).send({ error: 'Cover not found on Hardcover' });
      }
    } catch (err) {
      console.error('Hardcover error:', err);
      return reply.code(500).send({ error: 'Failed to fetch from Hardcover' });
    }
  });

  app.patch('/api/series/:id', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const body = req.body || {};

    // Cascade chapter states when monitor mode changes
    const modeChanged = body.monitorMode && body.monitorMode !== s.monitor_mode;
    const fromVolumeChanged = body.monitorMode === 'from' && body.monitorFromVolume != null &&
      parseFloat(body.monitorFromVolume) !== s.monitor_from_volume;
    if (modeChanged || fromVolumeChanged) {
      const chapters = listChaptersForSeries(s.id);
      if (body.monitorMode === 'none') {
        // Cancel all active downloads, then skip everything remaining
        await cancelSeries(s.id);
        const OWNED = new Set(['imported']);
        const unownedIds = chapters.filter(c => !OWNED.has(c.state) && c.state !== 'skipped').map(c => c.id);
        if (unownedIds.length) bulkSetChapterState(unownedIds, 'skipped');
      } else if (body.monitorMode === 'all') {
        // Mark skipped/failed chapters as wanted (leave active/owned ones alone)
        // Reset attempts so previously-failed chapters get a fresh start.
        const KEEP = new Set(['wanted', 'queued', 'downloading', 'downloaded', 'imported', 'bindery']);
        const ids = chapters.filter(c => !KEEP.has(c.state)).map(c => c.id);
        if (ids.length) bulkSetChapterState(ids, 'wanted', { resetAttempts: true });
        runOnce().catch(() => {});
      } else if (body.monitorMode === 'from' || (body.monitorMode == null && s.monitor_mode === 'from')) {
        // Apply threshold: chapters >= fromVolume → wanted, others → skipped.
        // Imported/bindery chapters are never downgraded.
        const threshold = parseFloat(body.monitorFromVolume ?? s.monitor_from_volume ?? 1);
        const OWNED = new Set(['imported', 'bindery']);
        const wantIds = [], skipIds = [];
        for (const c of chapters) {
          if (OWNED.has(c.state)) continue;
          const chVol = c.volume != null ? parseFloat(c.volume) : null;
          const meetsThreshold = chVol != null && chVol >= threshold;
          if (meetsThreshold && (c.state === 'skipped' || c.state === 'failed')) wantIds.push(c.id);
          if (!meetsThreshold && !['skipped'].includes(c.state)) skipIds.push(c.id);
        }
        if (skipIds.length) { await cancelSeries(s.id); bulkSetChapterState(skipIds, 'skipped'); }
        if (wantIds.length) { bulkSetChapterState(wantIds, 'wanted', { resetAttempts: true }); runOnce().catch(() => {}); }
      }
      // 'future', 'some': no cascade on existing chapters
    }

    return seriesView(updateSeries(s.id, body));
  });

  app.delete('/api/series/:id', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    deleteSeries(s.id);
    return reply.code(204).send();
  });

  app.post('/api/series/:id/refresh', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const r = await refreshSeries(s.id);
    // Drain queue in the background so the request returns promptly.
    runOnce().catch(() => {});
    return r;
  });

  app.post('/api/series/:id/link-mangadex', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    let { providerSeriesId } = req.body || {};
    if (!providerSeriesId) return reply.code(400).send({ error: 'providerSeriesId is required' });
    const matchUUID = String(providerSeriesId).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (matchUUID) providerSeriesId = matchUUID[0];
    else providerSeriesId = String(providerSeriesId).trim();

    if (!isProviderEnabled('mangadex')) return reply.code(400).send({ error: 'MangaDex provider is disabled' });

    const provider = getProvider('mangadex');
    const details = await provider.getSeries(providerSeriesId);

    updateSeries(s.id, {
      provider: 'mangadex',
      providerSeriesId,
      downloadProvider: 'mangadex',
      mediaType: 'manga',
      title: details.title,
      coverPath: details.coverPath ?? null,
    });

    await refreshSeries(s.id);
    await scanLibrary({ seriesId: s.id });
    runOnce().catch(() => {});

    const updated = getSeries(s.id);
    return { ...seriesView(updated), chapters: listChaptersForSeries(updated.id).map(chapterView) };
  });

  // Bulk-set chapter states for a series (optionally scoped to one volume).
  app.post('/api/series/:id/set-chapter-states', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { state, volume } = req.body || {};
    if (!['wanted', 'skipped'].includes(state)) return reply.code(400).send({ error: 'state must be wanted or skipped' });

    let chapters = listChaptersForSeries(s.id);
    if (volume !== undefined) {
      const v = volume === null ? null : String(volume);
      chapters = chapters.filter(c => (c.volume ?? null) === v);
    }

    let updated = 0;
    if (state === 'skipped') {
      const ACTIVE = new Set(['wanted', 'queued', 'downloading', 'downloaded']);
      const OWNED = new Set(['imported', 'bindery']);
      for (const ch of chapters) {
        if (OWNED.has(ch.state)) continue;
        if (ACTIVE.has(ch.state)) { await cancelChapter(ch.id); updated++; }
        else if (ch.state !== 'skipped') { setChapterState(ch.id, 'skipped'); updated++; }
      }
    } else {
      const KEEP = new Set(['imported', 'bindery', 'downloading', 'queued', 'downloaded', 'wanted']);
      const ids = chapters.filter(c => !KEEP.has(c.state)).map(c => c.id);
      if (ids.length) bulkSetChapterState(ids, 'wanted', { resetAttempts: true });
      updated = ids.length;
      if (ids.length) runOnce().catch(() => {});
    }

    // Manually adjusting a volume → mark tracking as 'some'
    if (volume !== undefined && s.monitor_mode !== 'some') {
      updateSeries(s.id, { monitorMode: 'some' });
    }

    await autoPackageCompleteVolumes(s.id);
    return { ok: true, updated };
  });

  // Cancel all active downloads for a series (in-flight + queued + downloaded).
  app.post('/api/series/:id/cancel', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return cancelSeries(s.id);
  });

  // Re-queue every failed chapter for a series.
  app.post('/api/series/:id/retry-failed', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const ids = listChaptersForSeries(s.id).filter(c => c.state === 'failed').map(c => c.id);
    bulkSetChapterState(ids, 'wanted', { resetAttempts: true });
    if (ids.length) runOnce().catch(() => {});
    return { ok: true, retried: ids.length };
  });

  // --- Chapter actions ---
  app.post('/api/chapters/:id/retry', async (req, reply) => {
    const c = getChapter(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    setChapterState(c.id, 'wanted', { error: null, attempts: 0 });
    runOnce().catch(() => {});
    return { ok: true };
  });

  app.post('/api/chapters/:id/skip', async (req, reply) => {
    const c = getChapter(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    setChapterState(c.id, 'skipped');
    return { ok: true };
  });

  // Explicitly track/un-track a single chapter; sets series monitorMode to 'some'.
  app.post('/api/chapters/:id/track', async (req, reply) => {
    const c = getChapter(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    const { state } = req.body || {};
    if (!['wanted', 'skipped'].includes(state)) return reply.code(400).send({ error: 'state must be wanted or skipped' });
    if (state === 'skipped') {
      await cancelChapter(c.id);
    } else {
      setChapterState(c.id, 'wanted', { error: null, attempts: 0 });
      runOnce().catch(() => {});
    }
    const s = getSeries(c.series_id);
    if (s && s.monitor_mode !== 'some') updateSeries(s.id, { monitorMode: 'some' });
    return { ok: true };
  });

  // Cancel a download: aborts it if in-flight, else drops it from the queue.
  // Settles on `skipped` (re-`want` to resume).
  app.post('/api/chapters/:id/cancel', async (req, reply) => {
    const c = getChapter(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    return cancelChapter(c.id);
  });

  // Force re-download a chapter you already own (overwrites the existing CBZ).
  app.post('/api/chapters/:id/redownload', async (req, reply) => {
    const c = getChapter(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    setChapterState(c.id, 'wanted', { error: null, attempts: 0, cbz_path: null, staging_path: null, prog_done: null, prog_total: null });
    runOnce().catch(() => {});
    return { ok: true };
  });

  // --- Delete series files ---
  // Preview which files on disk would be deleted (dry-run).
  app.post('/api/series/:id/delete-files/preview', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { scope = 'all', volume, chapterId } = req.body || {};

    let candidates = listChaptersForSeries(s.id);
    if (scope === 'volume' && volume !== undefined) {
      const v = volume === null ? null : String(volume);
      candidates = candidates.filter(c => (c.volume === null ? null : String(c.volume)) === v);
    } else if (scope === 'chapter' && chapterId) {
      candidates = candidates.filter(c => c.id === Number(chapterId));
    }

    const LOCAL_STATES = new Set(['imported', 'downloaded', 'bindery']);
    const files = candidates
      .filter(c => LOCAL_STATES.has(c.state) || (c.cbz_path && !c.cbz_path.startsWith('included_in_vol_')))
      .map(c => ({ chapterId: c.id, chapterNumber: c.number, volume: c.volume, filePath: c.cbz_path || '(Missing file)' }));

    return { seriesId: s.id, files, total: files.length };
  });

  // Actually delete files — caller must pass the explicit chapterIds they confirmed
  // (prevents deleting more than was previewed).
  app.post('/api/series/:id/delete-files', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { chapterIds } = req.body || {};
    if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
      return reply.code(400).send({ error: 'chapterIds array required' });
    }

    // GUARDRAIL: re-fetch all chapters for this series; reject any IDs not in it
    const allSeriesChapters = listChaptersForSeries(s.id);
    const ownedIds = new Set(allSeriesChapters.map(c => c.id));
    const LOCAL_STATES = new Set(['imported', 'downloaded', 'bindery']);
    const toDelete = chapterIds
      .map(id => Number(id))
      .filter(id => ownedIds.has(id))
      .map(id => allSeriesChapters.find(c => c.id === id))
      .filter(c => c && (LOCAL_STATES.has(c.state) || (c.cbz_path && !c.cbz_path.startsWith('included_in_vol_'))));

    const defaultState = s.monitor_mode === 'none' ? 'skipped' : 'wanted';
    const resetExtra = defaultState === 'wanted' ? { cbz_path: null, staging_path: null, attempts: 0 } : { cbz_path: null, staging_path: null };
    let deleted = 0;
    const errors = [];
    for (const c of toDelete) {
       try {
        if (c.cbz_path && existsSync(c.cbz_path)) {
          const st = statSync(c.cbz_path);
          if (st.isDirectory()) {
            rmSync(c.cbz_path, { recursive: true, force: true });
          } else {
            unlinkSync(c.cbz_path);
          }
          deleted++;
        }
        setChapterState(c.id, defaultState, resetExtra);
      } catch (err) {
        errors.push({ chapterId: c.id, error: err.message });
      }
    }

    return { ok: true, deleted, errors };
  });

  // --- Queue / history ---
  // Enriched with the parent series' title/cover/mediaType so Activity can show
  // real names + thumbnails instead of bare #ids.
  app.get('/api/queue', async () => {
    const placeholders = ACTIVE_STATES.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT c.*, s.title AS series_title, s.cover_path AS series_cover, s.media_type AS series_media_type
         FROM chapters c JOIN series s ON s.id = c.series_id
        WHERE c.state IN (${placeholders})
        ORDER BY CASE c.state WHEN 'downloading' THEN 0 WHEN 'downloaded' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, c.updated_at DESC
        LIMIT 200`
    ).all(...ACTIVE_STATES);
    return rows.map(r => ({
      ...chapterView(r),
      seriesTitle: r.series_title,
      seriesCover: r.series_cover || null,
      seriesMediaType: r.series_media_type || 'manga',
    }));
  });

  app.get('/api/activity', async () => {
    const queueRows = getDb().prepare(`
      SELECT c.*, s.title AS series_title, s.cover_path AS series_cover, s.media_type AS series_media_type
      FROM chapters c JOIN series s ON s.id = c.series_id
      WHERE c.state IN ('wanted', 'queued', 'downloading')
      ORDER BY CASE c.state WHEN 'downloading' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, c.updated_at DESC
      LIMIT 200
    `).all();
    const queue = queueRows.map(r => ({
      ...chapterView(r),
      seriesTitle: r.series_title,
      seriesCover: r.series_cover || null,
      seriesMediaType: r.series_media_type || 'manga',
    }));

    const procVols = getDb().prepare(`
      SELECT c.series_id, s.title AS series_title, s.cover_path AS series_cover, s.media_type AS series_media_type,
             c.volume,
             SUM(CASE WHEN c.state IN ('imported', 'bindery', 'downloaded') THEN 1 ELSE 0 END) AS owned_count,
             COUNT(*) AS total_count
      FROM chapters c
      JOIN series s ON s.id = c.series_id
      GROUP BY c.series_id, c.volume
      HAVING SUM(CASE WHEN c.state IN ('wanted', 'queued', 'downloading', 'downloaded') THEN 1 ELSE 0 END) > 0
      ORDER BY s.title, c.volume
    `).all();

    const processing = [];
    for (const pv of procVols) {
      const chs = getDb().prepare(`
        SELECT * FROM chapters 
        WHERE series_id = ? AND (volume = ? OR (volume IS NULL AND ? = 'none'))
        ORDER BY CAST(number AS REAL), number
      `).all(pv.series_id, pv.volume, pv.volume || 'none');

      processing.push({
        seriesId: pv.series_id,
        seriesTitle: pv.series_title,
        seriesCover: pv.series_cover || null,
        seriesMediaType: pv.series_media_type || 'manga',
        volume: pv.volume || 'none',
        ownedCount: pv.owned_count,
        totalCount: pv.total_count,
        chapters: chs.map(chapterView),
      });
    }

     const outputDirNormalized = path.normalize(config.outputDir).toLowerCase();
    const binderyRows = getDb().prepare(`
      SELECT c.*, s.title AS series_title, s.cover_path AS series_cover, s.media_type AS series_media_type
      FROM chapters c JOIN series s ON s.id = c.series_id
      WHERE c.state = 'bindery' OR (c.state = 'imported' AND c.cbz_path IS NOT NULL AND c.cbz_path NOT LIKE 'included_in_vol_%')
      ORDER BY c.updated_at DESC
      LIMIT 1000
    `).all();

    // Group bindery rows by normalized cbz_path
    const packagesMap = new Map();
    for (const r of binderyRows) {
      if (!r.cbz_path) continue;
      const normPath = path.normalize(r.cbz_path).toLowerCase();
      
      const isBinderyFile = r.state === 'bindery' || normPath.startsWith(outputDirNormalized);
      if (!isBinderyFile) continue;

      if (!packagesMap.has(normPath)) {
        packagesMap.set(normPath, {
          cbzPath: r.cbz_path,
          seriesId: r.series_id,
          seriesTitle: r.series_title,
          seriesCover: r.series_cover || null,
          seriesMediaType: r.series_media_type || 'manga',
          volume: r.volume || null,
          rows: []
        });
      }
      packagesMap.get(normPath).rows.push(r);
    }

    const bindery = [];
    for (const pkg of packagesMap.values()) {
      let fileSize = 0;
      let realChapters = [];
      let packagedAt = null;

      const fileExists = existsSync(pkg.cbzPath);
      if (fileExists) {
        try {
          const st = statSync(pkg.cbzPath);
          fileSize = st.size;
        } catch {}
        try {
          const info = await readCbzInfo(pkg.cbzPath);
          realChapters = info?.chapters || [];
        } catch {}
      }

      // Find latest updated_at
      for (const r of pkg.rows) {
        if (!packagedAt || r.updated_at > packagedAt) {
          packagedAt = r.updated_at;
        }
      }

      bindery.push({
        cbzPath: pkg.cbzPath,
        fileName: path.basename(pkg.cbzPath),
        seriesId: pkg.seriesId,
        seriesTitle: pkg.seriesTitle,
        seriesCover: pkg.seriesCover,
        seriesMediaType: pkg.seriesMediaType,
        volume: pkg.volume,
        packagedAt: packagedAt || new Date().toISOString(),
        size: fileSize,
        realChapters,
        dbChapters: pkg.rows.map(r => ({
          id: r.id,
          number: r.number,
          title: r.title,
          state: r.state
        }))
      });
    }

    // Sort by packagedAt DESC
    bindery.sort((a, b) => b.packagedAt.localeCompare(a.packagedAt));

    const failedRows = getDb().prepare(`
      SELECT c.*, s.title AS series_title, s.cover_path AS series_cover, s.media_type AS series_media_type
      FROM chapters c JOIN series s ON s.id = c.series_id
      WHERE c.state = 'failed'
      ORDER BY c.updated_at DESC
      LIMIT 200
    `).all();
    const failed = failedRows.map(r => ({
      ...chapterView(r),
      seriesTitle: r.series_title,
      seriesCover: r.series_cover || null,
      seriesMediaType: r.series_media_type || 'manga',
    }));

    return {
      queue,
      processing,
      bindery,
      failed,
    };
  });

  // Delete a complete bindery package (and delete the physical file)
  app.post('/api/bindery/delete-package', async (req, reply) => {
    const { cbzPath } = req.body || {};
    if (!cbzPath) return reply.code(400).send({ error: 'cbzPath required' });

    const db = getDb();
    const chapters = db.prepare('SELECT * FROM chapters WHERE cbz_path = ?').all(cbzPath);

    if (chapters.length > 0) {
      const s = getSeries(chapters[0].series_id);
      const defaultState = (s && s.monitor_mode === 'none') ? 'skipped' : 'wanted';
      const resetExtra = defaultState === 'wanted' ? { cbz_path: null, staging_path: null, attempts: 0 } : { cbz_path: null, staging_path: null };

      // Delete the file if it exists and is under outputDir (safety guardrail)
      const outputDirNormalized = path.normalize(config.outputDir).toLowerCase();
      const targetNormalized = path.normalize(cbzPath).toLowerCase();
      if (targetNormalized.startsWith(outputDirNormalized) && existsSync(cbzPath)) {
        try {
          const st = statSync(cbzPath);
          if (st.isDirectory()) {
            rmSync(cbzPath, { recursive: true, force: true });
          } else {
            unlinkSync(cbzPath);
          }
        } catch (err) {
          return reply.code(500).send({ error: `Failed to delete file: ${err.message}` });
        }
      }

      // Reset the chapters
      for (const c of chapters) {
        setChapterState(c.id, defaultState, resetExtra);
      }
    } else {
      // If not in database but file exists, delete it anyway if in output directory
      const outputDirNormalized = path.normalize(config.outputDir).toLowerCase();
      const targetNormalized = path.normalize(cbzPath).toLowerCase();
      if (targetNormalized.startsWith(outputDirNormalized) && existsSync(cbzPath)) {
        try {
          unlinkSync(cbzPath);
        } catch (err) {
          return reply.code(500).send({ error: `Failed to delete file: ${err.message}` });
        }
      }
    }

    return { ok: true };
  });

  app.get('/api/history', async () => recentHistory(100));

  // --- Global download controls ---
  // Drain the queue right now instead of waiting for the scheduler.
  // Resets any chapters stuck in `downloading` (worker idle only), then starts.
  app.post('/api/downloads/run', async () => {
    if (isRunning()) {
      const aborted = abortStuckInFlight();
      if (aborted > 0) await new Promise(r => setTimeout(r, 500));
    }
    const active = listChaptersInStates(['downloading'], { limit: 10000 });
    for (const ch of active) {
      await cancelChapter(ch.id);
    }
    if (active.length > 0) {
      const placeholders = active.map(() => '?').join(',');
      getDb().prepare(`UPDATE chapters SET state = 'wanted', attempts = 0, prog_done = NULL, prog_total = NULL, started_at = NULL WHERE id IN (${placeholders})`).run(...active.map(c => c.id));
    }
    resetStaleIfIdle();
    await new Promise(r => setTimeout(r, 100));
    runOnce().catch(() => {});
    return { ok: true, started: true, requeued: active.length };
  });

  // Re-queue every failed chapter across all series.
  app.post('/api/downloads/retry-failed', async () => {
    const ids = listChaptersInStates(['failed'], { limit: 1000 }).map(c => c.id);
    bulkSetChapterState(ids, 'wanted', { resetAttempts: true });
    if (ids.length) runOnce().catch(() => {});
    return { ok: true, retried: ids.length };
  });

  // Cancel every active download across all series.
  app.post('/api/downloads/cancel-all', async () => {
    const active = listChaptersInStates(['wanted', 'queued', 'downloading', 'downloaded'], { limit: 1000 });
    for (const ch of active) await cancelChapter(ch.id);
    return { ok: true, cancelled: active.length };
  });

  // --- Settings ---
  app.get('/api/settings', async () => getAllSettings());
  app.patch('/api/settings', async (req) => {
    const body = req.body || {};
    for (const [k, v] of Object.entries(body)) setSetting(k, v);
    if ('scanIntervalHours' in body) startScheduler(); // re-arm with new interval
    return getAllSettings();
  });

  app.get('/api/audit-all', async (req, reply) => {
    const db = getDb();
    const series = db.prepare('SELECT id, title FROM series').all();
    const results = [];

    for (const s of series) {
      const chapters = db.prepare('SELECT id, number, volume, calculated FROM chapters WHERE series_id = ? ORDER BY CAST(number AS REAL), number').all(s.id);
      
      const volMap = {};
      for (const c of chapters) {
        if (c.volume == null || c.volume === '' || c.volume === 'none') continue;
        (volMap[c.volume] ||= []).push(c);
      }

      const volKeys = Object.keys(volMap).sort((a, b) => parseFloat(a) - parseFloat(b));
      const anomalies = [];

      const ranges = [];
      for (const vol of volKeys) {
        const chs = volMap[vol];
        const nums = chs.map(c => parseFloat(c.number)).filter(n => !isNaN(n));
        if (!nums.length) continue;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        ranges.push({ vol, min, max, chCount: chs.length });

        const span = max - min;
        if (span > 50 && chs.length < 30) {
          anomalies.push(`Volume ${vol} spans chapter numbers ${min} to ${max} (span of ${span}) but only has ${chs.length} chapters.`);
        }
      }

      for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
          const r1 = ranges[i];
          const r2 = ranges[j];
          const v1Num = parseFloat(r1.vol);
          const v2Num = parseFloat(r2.vol);
          if (!isNaN(v1Num) && !isNaN(v2Num) && v1Num < v2Num) {
            if (r1.max > r2.min) {
              anomalies.push(`Overlap anomaly: Volume ${r1.vol} goes up to Chapter ${r1.max}, but Volume ${r2.vol} starts at Chapter ${r2.min}.`);
            }
          }
        }
      }

      if (anomalies.length > 0) {
        results.push({
          seriesId: s.id,
          seriesTitle: s.title,
          anomalies,
        });
      }
    }

    return { ok: true, results };
  });

  app.post('/api/audit-cbz-integrity', async (req, reply) => {
    const { scope } = req.query || {};
    const seriesList = listSeries();
    const results = [];
    let filesAudited = 0;
    let issuesFound = 0;

    const outputDirNormalized = path.normalize(config.outputDir).toLowerCase();

    for (const s of seriesList) {
      const chapters = listChaptersForSeries(s.id);
      const byCbz = new Map();
      for (const c of chapters) {
        if (!c.cbz_path || c.cbz_path.startsWith('included_in_vol_')) continue;

        let isBinderyFile = false;
        if (c.state === 'bindery') {
          isBinderyFile = true;
        } else if (c.state === 'imported') {
          const normPath = path.normalize(c.cbz_path).toLowerCase();
          if (normPath.startsWith(outputDirNormalized)) {
            isBinderyFile = true;
          }
        }

        if (scope === 'bindery' && !isBinderyFile) continue;

        // Ensure we only audit imported or bindery states
        if (c.state === 'imported' || c.state === 'bindery') {
          if (!byCbz.has(c.cbz_path)) byCbz.set(c.cbz_path, []);
          byCbz.get(c.cbz_path).push(c);
        }
      }

      const seriesResults = {
        seriesId: s.id,
        seriesTitle: s.title,
        files: []
      };

      for (const [filePath, dbChapters] of byCbz.entries()) {
        filesAudited++;
        const fileIssues = [];
        let fileSize = 0;
        let fileExists = false;

        if (!existsSync(filePath)) {
          fileIssues.push(`File does not exist on disk: "${filePath}"`);
          issuesFound++;
        } else {
          fileExists = true;
          try {
            const st = statSync(filePath);
            fileSize = st.size;
            if (st.size === 0) {
              fileIssues.push(`CBZ file is empty (0 bytes)`);
              issuesFound++;
            } else {
              const info = await readCbzInfo(filePath);
              if (info.error) {
                fileIssues.push(`CBZ archive is unreadable or corrupt: ${info.error}`);
                issuesFound++;
              } else if (!info.isEpub && info.pageCount === 0) {
                fileIssues.push(`CBZ archive contains no image pages`);
                issuesFound++;
              } else if (info.chapters && info.chapters.length > 0) {
                const dbChNums = new Set(dbChapters.map(c => String(parseFloat(c.number))));
                const cbzChNums = new Set(info.chapters.map(num => String(parseFloat(num))));

                // 1. Missing in CBZ
                for (const num of dbChNums) {
                  if (!cbzChNums.has(num)) {
                    fileIssues.push(`Chapter ${num} is registered in database but missing inside the CBZ`);
                    issuesFound++;
                  }
                }

                // 2. Extra in CBZ
                for (const num of cbzChNums) {
                  if (!dbChNums.has(num)) {
                    fileIssues.push(`Chapter ${num} is present inside the CBZ but not mapped in database`);
                    issuesFound++;
                  }
                }
              }
            }
          } catch (err) {
            fileIssues.push(`Error reading CBZ file: ${err.message}`);
            issuesFound++;
          }
        }

        if (fileIssues.length > 0) {
          seriesResults.files.push({
            path: filePath,
            basename: path.basename(filePath),
            size: fileSize,
            exists: fileExists,
            issues: fileIssues
          });
        }
      }

      if (seriesResults.files.length > 0) {
        results.push(seriesResults);
      }
    }

    const report = {
      timestamp: new Date().toISOString(),
      filesAudited,
      issuesFound,
      results
    };

    if (scope !== 'bindery') {
      const reportPath = path.join(path.dirname(config.dbPath), 'cbz_integrity_report.json');
      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    }
    return report;
  });

  app.get('/api/audit-cbz-integrity', async (req, reply) => {
    const reportPath = path.join(path.dirname(config.dbPath), 'cbz_integrity_report.json');
    if (!existsSync(reportPath)) {
      return { timestamp: null, filesAudited: 0, issuesFound: 0, results: [] };
    }
    try {
      const data = readFileSync(reportPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return reply.code(500).send({ error: 'Failed to read integrity report' });
    }
  });

  app.post('/api/audit/fix-missing', async (req, reply) => {
    const reportPath = path.join(path.dirname(config.dbPath), 'cbz_integrity_report.json');
    if (!existsSync(reportPath)) {
      return { ok: false, error: 'No integrity report found. Run audit first.' };
    }

    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    } catch {
      return reply.code(500).send({ error: 'Failed to read integrity report' });
    }

    const db = getDb();
    let fixedCount = 0;

    for (const s of report.results || []) {
      const seriesObj = getSeries(s.seriesId);
      if (!seriesObj) continue;
      const defaultState = seriesObj.monitor_mode === 'none' ? 'skipped' : 'wanted';
      const resetExtra = defaultState === 'wanted' ? { cbz_path: null, staging_path: null, attempts: 0 } : { cbz_path: null, staging_path: null };

      for (const f of s.files || []) {
        for (const issue of f.issues || []) {
          const match = issue.match(/^Chapter (\d+(?:\.\d+)?) is registered in database but missing inside the CBZ$/);
          if (match) {
            const chNum = match[1];
            const row = db.prepare('SELECT id FROM chapters WHERE series_id = ? AND number = ?').get(s.seriesId, chNum);
            if (row) {
              setChapterState(row.id, defaultState, resetExtra);
              fixedCount++;
            }
          }
        }
      }
    }

    try {
      if (existsSync(reportPath)) unlinkSync(reportPath);
    } catch {}

    if (fixedCount > 0) {
      runOnce().catch(() => {});
    }

    return { ok: true, fixedCount };
  });
  // --- Providers ---
  app.get('/api/providers', async () => {
    const states = Object.fromEntries(getProviderStates().map(p => [p.name, p]));
    return describeProviders().map(p => ({ ...p, enabled: states[p.name]?.enabled ?? false, config: states[p.name]?.config ?? {} }));
  });
  app.patch('/api/providers/:name', async (req) => {
    const { name } = req.params;
    const { enabled, config } = req.body || {};
    if (enabled !== undefined) setProviderEnabled(name, !!enabled);
    if (config !== undefined) setProviderConfig(name, config);
    return { ok: true };
  });

  // Live reachability / credential check for a single source. Always returns 200
  // with { ok, message } so the UI can show the result inline (errors included).
  app.post('/api/providers/:name/test', async (req, reply) => {
    let provider;
    try { provider = getProvider(req.params.name); }
    catch { return reply.code(404).send({ error: 'unknown provider' }); }
    if (typeof provider.testConnection !== 'function') {
      return { ok: false, message: 'No connection test available for this source' };
    }
    try {
      const r = await provider.testConnection();
      return { ok: true, message: r?.message || 'Connection OK' };
    } catch (e) {
      return { ok: false, message: String(e?.message || e) };
    }
  });

  // --- Library reconciliation (mark already-owned CBZs) ---
  app.post('/api/library/scan', async () => scanLibrary({ force: true }));
  app.post('/api/series/:id/scan-library', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return scanLibrary({ seriesId: s.id });
  });
  app.post('/api/series/:id/extrapolate-volumes', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { chaptersPerVolume, maxVolume } = req.body || {};
    const db = getDb();
    const chapters = listChaptersForSeries(s.id);
    const volumeMap = {};
    for (const c of chapters) {
      const hasRealVolume = c.volume != null && c.volume !== '' && !c.calculated;
      if (hasRealVolume) {
        (volumeMap[c.volume] ||= []).push(c.number);
      } else if (c.state === 'imported' && c.volume) {
        (volumeMap[c.volume] ||= []).push(c.number);
      }
    }
    const stats = getVolumeStats(volumeMap);
    const finalChsPerVol = chaptersPerVolume ? Number(chaptersPerVolume) : (stats.avgChsPerVol || 10);

    if (maxVolume && Number(maxVolume) > 0 && Number(maxVolume) < 500) {
      let maxExisting = 0;
      for (const c of chapters) {
        const n = parseFloat(c.number);
        if (!isNaN(n)) maxExisting = Math.max(maxExisting, n);
      }
      const targetMaxCh = Number(maxVolume) * finalChsPerVol;
      const start = Math.floor(maxExisting) + 1;
      const end = Math.floor(targetMaxCh);
      if (start <= end && (end - start) < 100) {
        for (let num = start; num <= end; num++) {
          const numStr = String(num);
          const exists = db.prepare("SELECT 1 FROM chapters WHERE series_id = ? AND number = ?").get(s.id, numStr);
          if (!exists) {
            db.prepare(`
              INSERT INTO chapters (series_id, provider, number, volume, title, language, state, calculated)
              VALUES (?, ?, ?, ?, ?, ?, 'wanted', 0)
            `).run(s.id, s.provider || 'mangadex', numStr, null, `Chapter ${numStr}`, s.language || 'en');
          }
        }
      }
    }

    const res = resolveVolumes(s.id, { chaptersPerVolume: chaptersPerVolume ? Number(chaptersPerVolume) : null });
    await autoPackageCompleteVolumes(s.id);
    return res;
  });
  app.get('/api/series/:id/extrapolate-preview', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const chsPerVolOverride = req.query.chaptersPerVolume ? Number(req.query.chaptersPerVolume) : null;
    const maxVolume = req.query.maxVolume ? Number(req.query.maxVolume) : null;
    const chapters = listChaptersForSeries(s.id);
    const volumeMap = {};
    const unassigned = [];
    for (const c of chapters) {
      const hasRealVolume = c.volume != null && c.volume !== '' && !c.calculated;
      if (hasRealVolume) {
        (volumeMap[c.volume] ||= []).push(c.number);
      } else if (c.state === 'imported' && c.volume) {
        (volumeMap[c.volume] ||= []).push(c.number);
      } else {
        unassigned.push(c.number);
      }
    }
    const stats = getVolumeStats(volumeMap);
    const finalChsPerVol = chsPerVolOverride || stats.avgChsPerVol || 10;

    const unassignedCopy = [...unassigned];
    if (maxVolume && maxVolume > 0 && maxVolume < 500) {
      let maxExisting = 0;
      for (const c of chapters) {
        const n = parseFloat(c.number);
        if (!isNaN(n)) maxExisting = Math.max(maxExisting, n);
      }
      const targetMaxCh = maxVolume * finalChsPerVol;
      const start = Math.floor(maxExisting) + 1;
      const end = Math.floor(targetMaxCh);
      if (start <= end && (end - start) < 100) {
        for (let num = start; num <= end; num++) {
          unassignedCopy.push(String(num));
        }
      }
    }

    const { calculated, overflow } = extrapolateVolumes(volumeMap, unassignedCopy, s.total_volumes_hint || null, false, finalChsPerVol);
    const volumes = Object.entries(calculated)
      .filter(([k]) => k !== 'Specials')
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .map(([vol, chs]) => {
        const sorted = [...chs].sort((a, b) => parseFloat(a) - parseFloat(b));
        return { vol, count: chs.length, chapters: sorted };
      });
    return {
      chsPerVol: finalChsPerVol,
      consecutiveVols: stats.lastConsecutive,
      totalUnassigned: unassignedCopy.length,
      volumes,
      overflow: overflow.length,
    };
  });
  app.post('/api/series/:id/volume-definitions', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { volumes = [] } = req.body || {};
    if (!Array.isArray(volumes)) return reply.code(400).send({ error: 'volumes array required' });
    const db = getDb();
    
    // Clear old volume assignments (excluding Specials) first
    db.prepare(`
      UPDATE chapters 
      SET volume = NULL, calculated = 0, updated_at = datetime('now')
      WHERE series_id = ? AND (volume != 'Specials' OR volume IS NULL)
    `).run(s.id);

    const upd = db.prepare("UPDATE chapters SET volume = ?, calculated = 0, updated_at = datetime('now') WHERE series_id = ? AND CAST(number AS REAL) >= ? AND CAST(number AS REAL) <= ?");
    let totalChanges = 0;
    for (const { volume, from, to } of volumes) {
      if (!volume || from == null || to == null) continue;

      // Auto-create missing integer chapters in the range [from, to]
      const start = Math.floor(Number(from));
      const end = Math.floor(Number(to));
      if (!Number.isNaN(start) && !Number.isNaN(end) && start > 0 && end >= start && (end - start) < 50) {
        for (let num = start; num <= end; num++) {
          const numStr = String(num);
          const exists = db.prepare("SELECT 1 FROM chapters WHERE series_id = ? AND number = ?").get(s.id, numStr);
          if (!exists) {
            db.prepare(`
              INSERT INTO chapters (series_id, provider, number, volume, title, language, state, calculated)
              VALUES (?, ?, ?, ?, ?, ?, 'wanted', 0)
            `).run(s.id, s.provider || 'mangadex', numStr, String(volume), `Chapter ${numStr}`, s.language || 'en');
          }
        }
      }

      const res = upd.run(String(volume), s.id, Number(from), Number(to));
      totalChanges += res.changes;
    }
    await refreshSeries(s.id);
    await autoPackageCompleteVolumes(s.id);
    return { ok: true, changes: totalChanges };
  });
  app.post('/api/series/:id/custom-volume', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { volume, from, to } = req.body || {};
    if (!volume || from == null || to == null) return reply.code(400).send({ error: 'invalid range' });
    const db = getDb();

    // Auto-create missing integer chapters in the range [from, to]
    const start = Math.floor(Number(from));
    const end = Math.floor(Number(to));
    if (!Number.isNaN(start) && !Number.isNaN(end) && start > 0 && end >= start && (end - start) < 50) {
      for (let num = start; num <= end; num++) {
        const numStr = String(num);
        const exists = db.prepare("SELECT 1 FROM chapters WHERE series_id = ? AND number = ?").get(s.id, numStr);
        if (!exists) {
          db.prepare(`
            INSERT INTO chapters (series_id, provider, number, volume, title, language, state, calculated)
            VALUES (?, ?, ?, ?, ?, ?, 'wanted', 0)
          `).run(s.id, s.provider || 'mangadex', numStr, String(volume), `Chapter ${numStr}`, s.language || 'en');
        }
      }
    }

    const upd = db.prepare("UPDATE chapters SET volume = ?, calculated = 0, updated_at = datetime('now') WHERE series_id = ? AND CAST(number AS REAL) >= ? AND CAST(number AS REAL) <= ?");
    const res = upd.run(String(volume), s.id, Number(from), Number(to));
    await refreshSeries(s.id);
    await autoPackageCompleteVolumes(s.id);
    return { ok: true, changes: res.changes };
  });
  app.get('/api/series/:id/audit-volumes', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return auditSeriesVolumes(s.id);
  });
  app.post('/api/series/:id/chapters/:chapterId/package', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const res = await packageSingleChapter(s.id, Number(req.params.chapterId));
    return { ok: true, path: res.path };
  });
  app.post('/api/series/:id/volumes/:volKey/package', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const res = await packageSingleVolume(s.id, req.params.volKey);
    return { ok: true, path: res.path };
  });
  app.post('/api/series/:id/package-volumes', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { volumes = [] } = req.body || {};
    let packagedCount = 0;
    for (const vk of volumes) {
      try {
        await packageSingleVolume(s.id, String(vk));
        packagedCount++;
      } catch {}
    }
    return { ok: true, packagedCount };
  });
  app.get('/api/series/:id/manual-search', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const query = req.query.query || s.title;
    if (s.provider === 'mangadex' || s.media_type === 'manga') {
      const numMatch = query.match(/(\d+(?:\.\d+)?)/);
      if (numMatch && s.provider_series_id) {
        try {
          const chNum = numMatch[1];
          const res = await fetch(`https://api.mangadex.org/chapter?manga=${s.provider_series_id}&chapter=${chNum}&order[publishAt]=desc`);
          const data = await res.json();
          if (data?.data?.length) {
            const list = [...data.data];
            list.sort((a, b) => {
              const getLangScore = (l) => {
                if (l === s.language) return 4;
                if (l === 'en') return 3;
                if (l === 'fr') return 2;
                return 1;
              };
              const scoreA = getLangScore(a.attributes?.translatedLanguage);
              const scoreB = getLangScore(b.attributes?.translatedLanguage);
              if (scoreA !== scoreB) return scoreB - scoreA;
              return 0;
            });
            return list.map(c => ({
              id: c.id,
              title: `Ch. ${c.attributes.chapter}: ${c.attributes.title || 'No Title'} [${c.attributes.translatedLanguage}]`,
            }));
          }
        } catch {}
      }
      const provider = getProvider('mangadex');
      return provider.search(query);
    }
    const provider = getProvider('getcomics');
    return provider.search(query);
  });
  app.post('/api/series/:id/chapters/:chapterId/manual-download', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    const ch = getChapter(Number(req.params.chapterId));
    if (!s || !ch) return reply.code(404).send({ error: 'not found' });
    const { url } = req.body || {};
    if (!url) return reply.code(400).send({ error: 'url required' });

    setChapterState(ch.id, 'wanted', { download_url: url, error: null, attempts: 0 });
    runOnce().catch(() => {});
    return { ok: true };
  });
  app.post('/api/series/:id/volumes/:volKey/manual-download', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const volKey = req.params.volKey;
    const { url } = req.body || {};
    if (!url) return reply.code(400).send({ error: 'url required' });

    const chapters = listChaptersForSeries(s.id).filter(c => (c.volume || 'none') === volKey);
    if (chapters.length > 0) {
      const sorted = [...chapters].sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
      const first = sorted[0];
      setChapterState(first.id, 'wanted', { download_url: url, error: null, attempts: 0 });
      for (let i = 1; i < sorted.length; i++) {
        setChapterState(sorted[i].id, 'imported', { cbz_path: `included_in_vol_${volKey}` });
      }
    }
    runOnce().catch(() => {});
    return { ok: true };
  });
  // Read-only: discover series on disk that aren't followed yet.
  // For entries without a provider ID, attempt a MangaDex title search to
  // auto-link them (best-effort, non-fatal).
  const untrackedTriageCache = new Map();

  app.get('/api/library/untracked', async () => {
    const { untracked } = await scanLibrary();
    const mdxEnabled = isProviderEnabled('mangadex');
    const cvEnabled = isProviderEnabled('comicvine');
    let hcEnabled = false;
    try {
      const cfg = getProviderConfig('hardcover') || {};
      hcEnabled = isProviderEnabled('hardcover') && !!(cfg.apikey || process.env.HARDCOVER_API_KEY);
    } catch {}

    const resolved = [];
    for (let i = 0; i < untracked.length; i += 5) {
      const chunk = untracked.slice(i, i + 5);
      const resChunk = await Promise.all(chunk.map(async (s) => {
        if (s.mangadexId || s.comicvineId) return s;
        const cacheKey = s.title.toLowerCase().trim();
        const cached = untrackedTriageCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts < 1800000)) return { ...s, ...cached.res };

        const compute = async () => {
          let mediaType = s.mediaType || 'manga';

          // 1. Hardcover Triage
          if (hcEnabled) {
            try {
              const hc = await hardcover.classifyMedia(s.title, s);
              if (hc.mediaType === 'book') return { mediaType: 'book' };
              mediaType = hc.mediaType;
            } catch {}
          }

          // 2. ComicVine search if comic
          if (mediaType === 'comic' && cvEnabled) {
            try {
              const results = await searchVolumes(s.title);
              const best = results[0];
              if (best && titlesMatch(s.title, best.title)) return { comicvineId: best.id, mediaType: 'comic' };
            } catch {}
          }

          // 3. MangaDex search
          if (mdxEnabled) {
            try {
              const results = await searchManga(s.title);
              const best = results[0];
              if (best && titlesMatch(s.title, best.title)) return { mangadexId: best.id, mediaType: 'manga' };
            } catch {}
          }

          // 4. Fallback: if MangaDex didn't match and we haven't tried ComicVine yet
          if (mediaType !== 'comic' && cvEnabled && !s.mangadexId) {
            try {
              const results = await searchVolumes(s.title);
              const best = results[0];
              if (best && titlesMatch(s.title, best.title)) return { comicvineId: best.id, mediaType: 'comic' };
            } catch {}
          }

          return { mediaType };
        };

        const res = await compute();
        untrackedTriageCache.set(cacheKey, { ts: Date.now(), res });
        return { ...s, ...res };
      }));
      resolved.push(...resChunk);
    }

    const finalUntracked = resolved.filter(s => {
      if (s.mediaType === 'book') return false; // Hardcover confirmed standard book
      if (s.isSingleEpub && !s.mangadexId && !s.comicvineId) return false;
      return true;
    });

    return { untracked: finalUntracked };
  });

  // --- Manage Files (Sonarr-style manual file mapping) ---

  // Browse server-side directories for the folder picker UI.
  app.get('/api/files/dirs', async (req, reply) => {
    const requested = String(req.query.path || '/books').trim() || '/';
    const dir = path.resolve(requested);
    const parent = path.dirname(dir);
    if (!existsSync(dir)) return reply.code(404).send({ error: `Directory not found: ${dir}` });
    let st;
    try { st = statSync(dir); } catch { return reply.code(400).send({ error: 'Cannot stat path' }); }
    if (!st.isDirectory()) return reply.code(400).send({ error: 'Not a directory' });
    const dirs = [];
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) dirs.push({ name: e.name, path: path.join(dir, e.name) });
      }
    } catch { /* permission denied — return empty list */ }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return { path: dir, parent: dir !== parent ? parent : null, dirs };
  });

  // List CBZ/EPUB files in a directory for the file picker.
  app.get('/api/files/list', async (req, reply) => {
    const dir = String(req.query.dir || '').trim();
    if (!dir) return reply.code(400).send({ error: 'dir is required' });
    if (!existsSync(dir)) return reply.code(404).send({ error: 'Directory not found' });
    let stat;
    try { stat = statSync(dir); } catch { return reply.code(400).send({ error: 'Cannot stat path' }); }
    if (!stat.isDirectory()) return reply.code(400).send({ error: 'Not a directory' });
    const entries = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const ext = e.name.toLowerCase();
      if (e.isFile() && (ext.endsWith('.cbz') || ext.endsWith('.epub'))) {
        entries.push({ name: e.name, path: full });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { dir, files: entries };
  });

  // Auto-suggest file→chapter mappings by scanning a directory.
  app.get('/api/series/:id/auto-map', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const dir = String(req.query.dir || '').trim();
    if (!dir || !existsSync(dir)) return reply.code(400).send({ error: 'dir not found' });

    const chapters = listChaptersForSeries(s.id);
    const byNumber = new Map(chapters.map(c => [String(parseFloat(c.number)), c]));
    const byVolume = new Map();
    for (const c of chapters) {
      if (c.volume != null && c.volume !== '') {
        const vk = String(parseFloat(c.volume));
        if (!byVolume.has(vk)) byVolume.set(vk, []);
        byVolume.get(vk).push(c);
      }
    }

    const suggestions = []; // { chapterId, chapterNumber, chapterTitle, filePath, matchReason }
    const usedFiles = new Set();
    const usedChapters = new Set();

    const files = [];
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const ext = e.name.toLowerCase();
        if (e.isFile() && (ext.endsWith('.cbz') || ext.endsWith('.epub')))
          files.push(path.join(dir, e.name));
      }
    } catch { return reply.code(400).send({ error: 'Cannot read directory' }); }
    files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));

    for (const filePath of files) {
      const info = await readCbzInfo(filePath);

      // 1. Try issue number matching (comics: "#10 v10.cbz" → chapter 10)
      if (info.issueNum && byNumber.has(info.issueNum) && !usedChapters.has(info.issueNum)) {
        const ch = byNumber.get(info.issueNum);
        suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `issue #${info.issueNum}` });
        usedFiles.add(filePath); usedChapters.add(info.issueNum);
        continue;
      }

      // 2. Try volume matching → mark all chapters in that volume
      if (info.volume) {
        const volChaps = byVolume.get(String(parseFloat(info.volume)));
        if (volChaps && volChaps.length > 0) {
          for (const ch of volChaps) {
            if (!usedChapters.has(ch.number)) {
              suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `vol ${info.volume}` });
              usedChapters.add(ch.number);
            }
          }
          usedFiles.add(filePath);
          continue;
        }
      }

      // 3. Bare-number fallback: extract last number from filename as volume
      const base = path.basename(filePath).replace(/\.(cbz|epub)$/i, '');
      const bareM = base.match(/(?:^|[-_\s])0*(\d{1,4}(?:\.\d+)?)(?:$|[-_\s\.])/);
      if (bareM) {
        const vNum = String(parseFloat(bareM[1]));
        const volChaps = byVolume.get(vNum);
        if (volChaps && volChaps.length > 0) {
          for (const ch of volChaps) {
            if (!usedChapters.has(ch.number)) {
              suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `bare #${vNum}` });
              usedChapters.add(ch.number);
            }
          }
          usedFiles.add(filePath);
          continue;
        }
        // Try as chapter number
        if (byNumber.has(vNum) && !usedChapters.has(vNum)) {
          const ch = byNumber.get(vNum);
          suggestions.push({ chapterId: ch.id, chapterNumber: ch.number, chapterTitle: ch.title, filePath, matchReason: `bare ch ${vNum}` });
          usedFiles.add(filePath); usedChapters.add(vNum);
        }
      }
    }

    return { seriesId: s.id, suggestions, totalFiles: files.length, matchedFiles: usedFiles.size };
  });

  // Apply bulk file→chapter mappings (mark chapters as imported with the given path).
  app.post('/api/series/:id/map-files', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { mappings = [] } = req.body || {};
    if (!Array.isArray(mappings) || mappings.length === 0) return reply.code(400).send({ error: 'mappings array required' });

    let applied = 0;
    for (const { chapterId, filePath } of mappings) {
      const ch = getChapter(Number(chapterId));
      if (!ch || ch.series_id !== s.id) continue;
      if (!filePath || !existsSync(filePath)) continue;
      setChapterState(ch.id, 'imported', { cbz_path: filePath, calculated: ch.calculated || 0, language: s.language || 'en' });
      applied++;
    }
    return { ok: true, applied };
  });

  // --- Notifications ---
  app.post('/api/notify/test', async (req, reply) => {
    const res = await notify('mangas-binder', 'Test notification — your alerts are working.', { tags: ['white_check_mark'] });
    if (!res.configured) return reply.code(400).send({ error: 'No Discord webhook or ntfy URL configured' });
    return res;
  });

  // --- Manual triggers ---
  app.post('/api/scan', async () => {
    runScan().catch(() => {}); // long-running; fire and forget
    return { ok: true, started: true };
  });
}

async function autoPackageCompleteVolumes(seriesId) {
  const s = getSeries(seriesId);
  if (!s) return;
  const chapters = listChaptersForSeries(s.id);
  const byVolume = new Map();
  for (const c of chapters) {
    if (c.volume == null || c.volume === '') continue;
    if (!byVolume.has(c.volume)) byVolume.set(c.volume, []);
    byVolume.get(c.volume).push(c);
  }

  const isSeriesClosed = s.status === 'completed' || s.status === 'cancelled';
  let maxVolNum = -Infinity;
  for (const vk of byVolume.keys()) {
    const v = parseFloat(vk);
    if (!Number.isNaN(v)) maxVolNum = Math.max(maxVolNum, v);
  }

  const LOCAL_STATES = new Set(['imported', 'downloaded', 'bindery']);
  for (const [volLabel, vchapters] of byVolume) {
    const v = parseFloat(volLabel);
    const isClosed = isSeriesClosed || Number.isNaN(v) || v < maxVolNum;

    // A volume is complete if all non-skipped chapters are local
    const nonSkipped = vchapters.filter(c => c.state !== 'skipped');
    const allReady = nonSkipped.length > 0 && nonSkipped.every(c => LOCAL_STATES.has(c.state));

    if (allReady && isClosed) {
      try {
        await packageSingleVolume(s.id, volLabel);
      } catch (err) {
        console.error(`Failed to auto-package Vol ${volLabel} after override:`, err);
      }
    }
  }
}
