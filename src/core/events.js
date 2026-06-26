import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus for pushing live pipeline changes to connected UIs
 * (via the /api/events SSE stream) instead of having every browser poll on a
 * fixed timer. In-process, fire-and-forget: publishers never block or throw.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open SSE connection; don't warn

/** Emit a change. `type` is a coarse hint (chapter|progress|chapters|series|scan). */
export function publish(type, data = {}) {
  try { bus.emit('event', { type, data, ts: Date.now() }); } catch { /* never break a caller */ }
}
