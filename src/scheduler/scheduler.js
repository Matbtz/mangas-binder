import { listMonitoredSeries } from '../core/repo.js';
import { refreshSeries } from '../core/series-service.js';
import { scanLibrary } from '../core/library-scan.js';
import { runOnce, packageCompleteVolumes } from '../download/worker.js';
import { getSetting } from '../core/settings.js';
import { logHistory } from '../core/db.js';
import { pLimit, withTimeout } from '../download/limit.js';

/**
 * Periodic driver: every scanIntervalHours it refreshes every monitored series'
 * chapter list, then drains the download/bind queue. Also runnable on demand.
 */
let timer = null;
let scanning = false;

/**
 * One full cycle: refresh all monitored series, then process the queue.
 * @returns {Promise<{ refreshed, added, processed, imported, failed }>}
 */
export async function runScan() {
  if (scanning) return { skipped: 'already-running' };
  scanning = true;
  let refreshed = 0, added = 0;
  try {
    // Refresh series a few at a time, each bounded by a timeout, so a single
    // slow/blocked source can't stall (or serialise) the whole cycle.
    const concurrency = Math.max(1, Number(getSetting('refreshConcurrency', 3)) || 3);
    const timeoutMs = Math.max(0, Number(getSetting('seriesRefreshTimeoutSec', 90)) || 0) * 1000;
    const limit = pLimit(concurrency);
    await Promise.all(listMonitoredSeries().map(series => limit(async () => {
      try {
        const r = await withTimeout(refreshSeries(series.id), timeoutMs, `refresh series ${series.id}`);
        refreshed++;
        added += r.added;
      } catch (err) {
        logHistory('scan.error', { seriesId: series.id, message: String(err.message || err) });
      }
    })));
    // Reconcile with the on-disk library (catches files Tome moved or you added
    // manually) before downloading anything.
    const lib = await scanLibrary({ force: true });
    // Re-group any series whose on-disk CBZ was found under a stale volume onto
    // the corrected provider volumes (rebuilds from the same on-disk pages).
    let rematched = 0;
    for (const sid of lib.driftedSeries || []) {
      try { if (await packageCompleteVolumes(sid, { force: true })) rematched++; }
      catch (err) { logHistory('scan.error', { seriesId: sid, message: `rematch failed: ${err.message || err}` }); }
    }
    const work = await runOnce();
    return { refreshed, added, ownedMarked: lib.markedChapters, rematched, ...work };
  } finally {
    scanning = false;
  }
}

export function startScheduler() {
  stopScheduler();
  const hours = Number(getSetting('scanIntervalHours', 6)) || 6;
  const intervalMs = hours * 60 * 60 * 1000;
  // Kick once shortly after boot, then on the interval.
  timer = setInterval(() => { runScan().catch(() => {}); }, intervalMs);
  timer.unref?.();
  logHistory('scheduler.started', { message: `every ${hours}h` });
  return { intervalHours: hours };
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function schedulerStatus() {
  return { running: !!timer, scanning, intervalHours: Number(getSetting('scanIntervalHours', 6)) || 6 };
}
