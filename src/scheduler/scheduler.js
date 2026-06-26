import { listMonitoredSeries } from '../core/repo.js';
import { refreshSeries } from '../core/series-service.js';
import { scanLibrary } from '../core/library-scan.js';
import { runOnce } from '../download/worker.js';
import { getSetting } from '../core/settings.js';
import { logHistory } from '../core/db.js';

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
    for (const series of listMonitoredSeries()) {
      try {
        const r = await refreshSeries(series.id);
        refreshed++;
        added += r.added;
      } catch (err) {
        logHistory('scan.error', { seriesId: series.id, message: String(err.message || err) });
      }
    }
    // Reconcile with the on-disk library (catches files Tome moved or you added
    // manually) before downloading anything.
    const lib = await scanLibrary({ force: true });
    const work = await runOnce();
    return { refreshed, added, ownedMarked: lib.markedChapters, ...work };
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
