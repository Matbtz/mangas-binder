import { provider as mangadex } from './mangadex.js';
import { provider as mangaupdates } from './mangaupdates.js';
import { provider as comicvine } from './comicvine.js';
import { provider as getcomics } from './getcomics.js';
import { provider as hardcover } from './hardcover.js';
import { provider as mangakatana } from './mangakatana.js';
import { provider as fandom } from './fandom.js';
import { provider as mangabaka } from './mangabaka.js';

/**
 * Provider registry. Every source registers here; the rest of the app only
 * talks to providers through getProvider() / listProviders(), never by import.
 *
 * Enable/disable state lives in the DB (providers table). This module just
 * knows which providers *exist* and exposes their static descriptors.
 *
 * Capabilities:
 *   metadata    — can search + describe series/chapters (mangadex, comicvine)
 *   download    — can resolve page-image URLs (mangadex)
 *   archive     — can resolve a whole-archive (CBZ/ZIP) URL per chapter (getcomics)
 *   pageFallback— supplies page images by (series, chapterNumber) as a fallback
 *                 when the primary download provider fails (mangakatana)
 * A series pairs a metadata provider with a download/archive provider; for manga
 * they're the same (mangadex), for comics they differ (comicvine + getcomics).
 */
const REGISTRY = new Map([
  [mangadex.name, mangadex],
  [mangaupdates.name, mangaupdates],
  [comicvine.name, comicvine],
  [getcomics.name, getcomics],
  [hardcover.name, hardcover],
  [mangakatana.name, mangakatana],
  [fandom.name, fandom],
  [mangabaka.name, mangabaka],
]);

/** All registered providers (regardless of enabled state). */
export function allProviders() {
  return [...REGISTRY.values()];
}

/** Providers that can supply files (page images or whole archives). */
export function downloadProviders() {
  return allProviders().filter(p => p.capabilities.download || p.capabilities.archive);
}

/** Providers that can search + describe series (for the Add tab). */
export function metadataProviders() {
  return allProviders().filter(p => p.capabilities.metadata);
}

/** Default download/archive provider for a media type. */
export function defaultDownloadProvider(mediaType) {
  return mediaType === 'comic' ? 'getcomics' : 'mangadex';
}

/** Get a provider by name, or throw. */
export function getProvider(name) {
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}

/** Static descriptors for the API / UI (name, label, capabilities, mediaType). */
export function describeProviders() {
  return allProviders().map(p => ({
    name: p.name,
    label: p.label,
    mediaType: p.mediaType || 'manga',
    capabilities: p.capabilities,
  }));
}

/**
 * Best-effort provider + series-ID detection from a pasted URL, so "Add a
 * series" can follow one specific series directly instead of only by title
 * search. Returns null when the URL doesn't match a known source.
 */
export function detectProviderFromUrl(input) {
  const url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const mangadexMatch = url.match(/mangadex\.org.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (mangadexMatch) return { provider: 'mangadex', providerSeriesId: mangadexMatch[1] };

  if (/mangakatana\.com\/manga\//i.test(url)) return { provider: 'mangakatana', providerSeriesId: url };

  const comicvineMatch = url.match(/comicvine\.gamespot\.com\/[^/]*\/volume\/4050-(\d+)/i);
  if (comicvineMatch) return { provider: 'comicvine', providerSeriesId: comicvineMatch[1] };

  return null;
}
