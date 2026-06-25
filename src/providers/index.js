import { provider as mangadex } from './mangadex.js';
import { provider as mangaupdates } from './mangaupdates.js';

/**
 * Provider registry. Every source registers here; the rest of the app only
 * talks to providers through getProvider() / listProviders(), never by import.
 *
 * Enable/disable state lives in the DB (providers table). This module just
 * knows which providers *exist* and exposes their static descriptors.
 */
const REGISTRY = new Map([
  [mangadex.name, mangadex],
  [mangaupdates.name, mangaupdates],
]);

/** All registered providers (regardless of enabled state). */
export function allProviders() {
  return [...REGISTRY.values()];
}

/** Providers that can download pages. */
export function downloadProviders() {
  return allProviders().filter(p => p.capabilities.download);
}

/** Get a provider by name, or throw. */
export function getProvider(name) {
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}

/** Static descriptors for the API / UI (name, label, capabilities). */
export function describeProviders() {
  return allProviders().map(p => ({
    name: p.name,
    label: p.label,
    capabilities: p.capabilities,
  }));
}
