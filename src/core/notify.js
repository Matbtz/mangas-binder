import { getSetting } from './settings.js';
import { logHistory } from './db.js';

/**
 * Fire-and-forget notifications to Discord and/or ntfy. Both are optional and
 * configured in settings (discordWebhook, ntfyUrl). Failures are logged to
 * history but never thrown into the pipeline.
 *
 * @param {string} title
 * @param {string} message
 * @param {{ tags?: string[], priority?: string }} opts
 */
export async function notify(title, message, { tags = [], priority } = {}) {
  const discord = getSetting('discordWebhook', '');
  const ntfyUrl = getSetting('ntfyUrl', '');
  const jobs = [];
  if (discord) jobs.push(sendDiscord(discord, title, message));
  if (ntfyUrl) jobs.push(sendNtfy(ntfyUrl, title, message, { tags, priority }));
  if (!jobs.length) return { sent: 0, configured: false };

  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected');
  for (const f of failed) logHistory('notify.error', { message: String(f.reason?.message || f.reason) });
  return { sent: results.length - failed.length, failed: failed.length, configured: true };
}

async function sendDiscord(webhook, title, message) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `**${title}**\n${message}` }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

async function sendNtfy(url, title, message, { tags = [], priority } = {}) {
  const headers = { Title: title };
  if (tags.length) headers.Tags = tags.join(',');
  if (priority) headers.Priority = priority;
  const res = await fetch(url, { method: 'POST', headers, body: message });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}

/** Convenience hooks used by the worker. */
export function notifyImport(seriesTitle, what) {
  if (!getSetting('notifyOnImport', true)) return;
  notify(`📚 ${seriesTitle}`, `${what} added to your library`, { tags: ['books'] }).catch(() => {});
}

export function notifyError(seriesTitle, what, reason) {
  if (!getSetting('notifyOnError', false)) return;
  notify(`⚠️ ${seriesTitle}`, `${what} failed: ${reason}`, { tags: ['warning'], priority: 'high' }).catch(() => {});
}
