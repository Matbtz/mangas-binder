import { getProvider, describeProviders } from '../../providers/index.js';
import { searchManga } from '../../providers/mangadex.js';
import {
  listSeries, getSeries, updateSeries, deleteSeries,
  listChaptersForSeries, getChapter, setChapterState, bulkSetChapterState,
  listChaptersInStates, recentHistory,
} from '../../core/repo.js';
import { getDb } from '../../core/db.js';
import {
  getAllSettings, setSetting, getProviderStates,
  setProviderEnabled, setProviderConfig, isProviderEnabled,
} from '../../core/settings.js';
import { followSeries, refreshSeries } from '../../core/series-service.js';
import { scanLibrary } from '../../core/library-scan.js';
import { resolveVolumes } from '../../core/mapping.js';
import { packageSingleChapter, packageSingleVolume, auditSeriesVolumes } from '../../core/binder.js';
import { runScan, schedulerStatus, startScheduler } from '../../scheduler/scheduler.js';
import { runOnce, cancelChapter, cancelSeries } from '../../download/worker.js';
import { notify } from '../../core/notify.js';
import { seriesView, chapterView } from '../views.js';

const ACTIVE_STATES = ['wanted', 'queued', 'downloading', 'downloaded', 'failed'];

/** Normalise a title for fuzzy comparison: lowercase, strip punctuation, collapse spaces. */
function normTitle(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
/** True when two title strings are close enough to be the same series. */
function titlesMatch(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

/** Fastify plugin: all /api routes. */
export default async function apiRoutes(app) {
  // --- Health / status ---
  app.get('/api/health', async () => {
    const db = getDb();
    const seriesCount = db.prepare('SELECT COUNT(*) n FROM series').get().n;
    const byState = db.prepare('SELECT state, COUNT(*) n FROM chapters GROUP BY state').all();
    return { ok: true, seriesCount, chapters: Object.fromEntries(byState.map(r => [r.state, r.n])), scheduler: schedulerStatus() };
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
    const { provider = 'mangadex', providerSeriesId, monitorMode, packagingMode, language } = req.body || {};
    if (!providerSeriesId) return reply.code(400).send({ error: 'providerSeriesId is required' });
    const series = await followSeries(provider, providerSeriesId, { monitorMode, packagingMode, language });
    return reply.code(201).send(seriesView(series));
  });

  app.get('/api/series/:id', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return { ...seriesView(s), chapters: listChaptersForSeries(s.id).map(chapterView) };
  });

  app.patch('/api/series/:id', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return seriesView(updateSeries(s.id, req.body || {}));
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
    scanLibrary({ seriesId: s.id });
    runOnce().catch(() => {});

    const updated = getSeries(s.id);
    return { ...seriesView(updated), chapters: listChaptersForSeries(updated.id).map(chapterView) };
  });

  // Bulk-set chapter states for a series (optionally scoped to one volume).
  // Eligible states: any chapter not imported/downloading/queued.
  app.post('/api/series/:id/set-chapter-states', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { state, volume } = req.body || {};
    if (!['wanted', 'skipped'].includes(state)) return reply.code(400).send({ error: 'state must be wanted or skipped' });
    const SKIP = new Set(['imported', 'downloading', 'queued']);
    let chapters = listChaptersForSeries(s.id);
    if (volume !== undefined) {
      const v = volume === null ? null : String(volume);
      chapters = chapters.filter(c => (c.volume ?? null) === v);
    }
    const ids = chapters.filter(c => !SKIP.has(c.state)).map(c => c.id);
    bulkSetChapterState(ids, state);
    if (state === 'wanted') runOnce().catch(() => {});
    return { ok: true, updated: ids.length };
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
    bulkSetChapterState(ids, 'wanted');
    if (ids.length) runOnce().catch(() => {});
    return { ok: true, retried: ids.length };
  });

  // --- Chapter actions ---
  app.post('/api/chapters/:id/retry', async (req, reply) => {
    const c = getChapter(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    setChapterState(c.id, 'wanted', { error: null });
    runOnce().catch(() => {});
    return { ok: true };
  });

  app.post('/api/chapters/:id/skip', async (req, reply) => {
    const c = getChapter(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    setChapterState(c.id, 'skipped');
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
    setChapterState(c.id, 'wanted', { error: null, cbz_path: null, staging_path: null, prog_done: null, prog_total: null });
    runOnce().catch(() => {});
    return { ok: true };
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

  app.get('/api/history', async () => recentHistory(100));

  // --- Global download controls ---
  // Drain the queue right now instead of waiting for the scheduler.
  app.post('/api/downloads/run', async () => {
    runOnce().catch(() => {});
    return { ok: true, started: true };
  });

  // Re-queue every failed chapter across all series.
  app.post('/api/downloads/retry-failed', async () => {
    const ids = listChaptersInStates(['failed'], { limit: 1000 }).map(c => c.id);
    bulkSetChapterState(ids, 'wanted');
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
  app.post('/api/library/scan', async () => scanLibrary());
  app.post('/api/series/:id/scan-library', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return scanLibrary({ seriesId: s.id });
  });
  app.post('/api/series/:id/extrapolate-volumes', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return resolveVolumes(s.id);
  });
  app.post('/api/series/:id/custom-volume', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { volume, from, to } = req.body || {};
    if (!volume || from == null || to == null) return reply.code(400).send({ error: 'invalid range' });
    const db = getDb();
    const upd = db.prepare("UPDATE chapters SET volume = ?, calculated = 1, updated_at = datetime('now') WHERE series_id = ? AND CAST(number AS REAL) >= ? AND CAST(number AS REAL) <= ?");
    const res = upd.run(String(volume), s.id, Number(from), Number(to));
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

    setChapterState(ch.id, 'wanted', { download_url: url, error: null });
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
      setChapterState(first.id, 'wanted', { download_url: url, error: null });
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
  app.get('/api/library/untracked', async () => {
    const { untracked } = scanLibrary();
    const mdxEnabled = isProviderEnabled('mangadex');
    const resolved = await Promise.all(untracked.map(async (s) => {
      if (s.mangadexId || s.comicvineId || !mdxEnabled) return s;
      try {
        const results = await searchManga(s.title);
        const best = results[0];
        if (best && titlesMatch(s.title, best.title)) return { ...s, mangadexId: best.id };
      } catch { /* search failure is non-fatal */ }
      return s;
    }));
    return { untracked: resolved };
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
