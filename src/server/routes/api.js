import { getProvider, describeProviders } from '../../providers/index.js';
import {
  listSeries, getSeries, updateSeries, deleteSeries,
  listChaptersForSeries, getChapter, setChapterState,
  recentHistory,
} from '../../core/repo.js';
import { getDb } from '../../core/db.js';
import {
  getAllSettings, setSetting, getProviderStates,
  setProviderEnabled, setProviderConfig, isProviderEnabled,
} from '../../core/settings.js';
import { followSeries, refreshSeries } from '../../core/series-service.js';
import { scanLibrary } from '../../core/library-scan.js';
import { runScan, schedulerStatus, startScheduler } from '../../scheduler/scheduler.js';
import { runOnce } from '../../download/worker.js';
import { notify } from '../../core/notify.js';
import { seriesView, chapterView } from '../views.js';

const ACTIVE_STATES = ['wanted', 'queued', 'downloading', 'downloaded', 'failed'];

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

  // --- Queue / history ---
  app.get('/api/queue', async () => {
    const placeholders = ACTIVE_STATES.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT * FROM chapters WHERE state IN (${placeholders}) ORDER BY updated_at DESC LIMIT 200`
    ).all(...ACTIVE_STATES);
    return rows.map(chapterView);
  });

  app.get('/api/history', async () => recentHistory(100));

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

  // --- Library reconciliation (mark already-owned CBZs) ---
  app.post('/api/library/scan', async () => scanLibrary());
  app.post('/api/series/:id/scan-library', async (req, reply) => {
    const s = getSeries(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'not found' });
    return scanLibrary({ seriesId: s.id });
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
