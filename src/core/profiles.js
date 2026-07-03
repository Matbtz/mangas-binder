import { getDb } from './db.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Named image-processing profiles, persisted in the `image_profiles` table.
 * A profile's `config` is the treatment shape consumed by image-preprocess.js.
 * Which profile applies to each media type is stored in the `imageProfileAssignments`
 * setting ({ manga: id|null, comic: id|null }); the master `imageProcessingEnabled`
 * setting gates the whole feature.
 */

/** Sensible starting point for a new profile (PocketBook-style, all opt-in). */
export const DEFAULT_PROFILE_CONFIG = {
  grayscale: { enabled: true },
  autocontrast: { enabled: false, blackPoint: 0 },
  gamma: { enabled: false, value: 1.5 },
  crop: { enabled: false, power: 1.0, preserveMarginPct: 0 },
  spread: { enabled: true, mode: 'rotate', direction: 'rtl' },
  resize: { enabled: true, width: 1404, height: 1872, mode: 'fit', upscale: true },
  encode: { enabled: true, format: 'jpeg', quality: 90 },
};

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    config: JSON.parse(row.config_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProfiles() {
  return getDb()
    .prepare('SELECT * FROM image_profiles ORDER BY name COLLATE NOCASE')
    .all()
    .map(rowToProfile);
}

export function getProfile(id) {
  return rowToProfile(getDb().prepare('SELECT * FROM image_profiles WHERE id = ?').get(id));
}

export function createProfile(name, config = DEFAULT_PROFILE_CONFIG) {
  const info = getDb()
    .prepare('INSERT INTO image_profiles (name, config_json) VALUES (?, ?)')
    .run(String(name || 'New profile'), JSON.stringify(config || {}));
  return getProfile(Number(info.lastInsertRowid));
}

export function updateProfile(id, { name, config } = {}) {
  const cur = getProfile(id);
  if (!cur) return null;
  const newName = name !== undefined ? String(name) : cur.name;
  const newConfig = config !== undefined ? config : cur.config;
  getDb()
    .prepare("UPDATE image_profiles SET name = ?, config_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newName, JSON.stringify(newConfig || {}), id);
  return getProfile(id);
}

export function deleteProfile(id) {
  getDb().prepare('DELETE FROM image_profiles WHERE id = ?').run(id);
  // Drop any media-type assignment that pointed at the removed profile.
  const assignments = getSetting('imageProfileAssignments', { manga: null, comic: null });
  let changed = false;
  for (const k of Object.keys(assignments)) {
    if (assignments[k] === id) { assignments[k] = null; changed = true; }
  }
  if (changed) setSetting('imageProfileAssignments', assignments);
}

/**
 * Diagnostic view of what would be applied for a media type: whether the master
 * switch is on, which profile (if any) is assigned, and its config. Used both to
 * resolve the actual treatment and to explain the decision in activity logs.
 * @param {string} mediaType  'manga' | 'comic'
 * @returns {{ enabled: boolean, profile: {id, name}|null, config: object|null }}
 */
export function describeProfileForMedia(mediaType) {
  const mt = mediaType || 'manga';
  const enabled = getSetting('imageProcessingEnabled', false);
  if (!enabled) return { enabled: false, profile: null, config: null };
  const assignments = getSetting('imageProfileAssignments', {});
  const id = assignments?.[mt];
  if (id == null) return { enabled: true, profile: null, config: null };
  const profile = getProfile(id);
  if (!profile) return { enabled: true, profile: null, config: null };
  return { enabled: true, profile: { id: profile.id, name: profile.name }, config: profile.config };
}

/**
 * The profile config to apply for a media type, or null when preprocessing is
 * disabled, no profile is assigned, or the assigned profile no longer exists.
 * @param {string} mediaType  'manga' | 'comic'
 */
export function resolveProfileForMedia(mediaType) {
  return describeProfileForMedia(mediaType).config;
}
