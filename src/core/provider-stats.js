import { getDb } from './db.js';

export function recordChapterSuccess(providerName, scanQuality) {
  const db = getDb();
  let row = db.prepare('SELECT quality_score, quality_samples FROM provider_stats WHERE provider_name = ?').get(providerName);

  if (!row) {
    db.prepare("INSERT INTO provider_stats (provider_name, chapters_ok, chapters_failed, quality_score, quality_samples, warnings_json, last_updated) VALUES (?, 0, 0, -1, 0, '[]', datetime('now'))").run(providerName);
    row = { quality_score: -1, quality_samples: 0 };
  }

  const scoreMap = { high: 1.0, ok: 0.75, low: 0.25, unknown: 0.5 };
  const chapterScore = scoreMap[scanQuality] ?? 0.5;

  let newScore = row.quality_score;
  let newSamples = row.quality_samples + 1;

  if (newSamples <= 5) {
    // Simple average during warm-up
    const currentTotal = row.quality_score === -1 ? 0 : row.quality_score * row.quality_samples;
    newScore = (currentTotal + chapterScore) / newSamples;
  } else {
    // EMA
    newScore = 0.15 * chapterScore + 0.85 * row.quality_score;
  }

  db.prepare(`UPDATE provider_stats
              SET chapters_ok = chapters_ok + 1,
                  quality_score = ?,
                  quality_samples = ?,
                  last_updated = datetime('now')
              WHERE provider_name = ?`).run(newScore, newSamples, providerName);
}

export function recordChapterFailure(providerName, errorMessage) {
  const db = getDb();
  let row = db.prepare('SELECT warnings_json FROM provider_stats WHERE provider_name = ?').get(providerName);

  if (!row) {
    db.prepare("INSERT INTO provider_stats (provider_name, chapters_ok, chapters_failed, quality_score, quality_samples, warnings_json, last_updated) VALUES (?, 0, 0, -1, 0, '[]', datetime('now'))").run(providerName);
    row = { warnings_json: '[]' };
  }

  let warnings = [];
  try {
    warnings = JSON.parse(row.warnings_json);
  } catch (e) {}

  warnings.push({ ts: new Date().toISOString(), message: errorMessage });
  // Ring buffer deduplication? Actually the instructions say:
  // "warnings_json is a capped ring buffer of the last 20 distinct error messages with timestamps"

  // To deduplicate distinct messages:
  // Find if message exists, remove it, push to end to update timestamp.
  const existingIdx = warnings.findIndex(w => w.message === errorMessage);
  if (existingIdx !== -1) {
    warnings.splice(existingIdx, 1);
  } else if (warnings.length >= 20) {
     warnings.shift();
  }
  // This satisfies 'last N error messages' and 'distinct' from deduplication point

  db.prepare(`UPDATE provider_stats
              SET chapters_failed = chapters_failed + 1,
                  warnings_json = ?,
                  last_updated = datetime('now')
              WHERE provider_name = ?`).run(JSON.stringify(warnings), providerName);
}

export function getProviderStats(providerName) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM provider_stats WHERE provider_name = ?').get(providerName);

  if (!row) {
    return {
      chaptersOk: 0,
      chaptersFailed: 0,
      qualityScore: -1,
      qualitySamples: 0,
      healthStatus: 'green',
      warnings: []
    };
  }

  const { chapters_ok: chaptersOk, chapters_failed: chaptersFailed, quality_score: qualityScore, quality_samples: qualitySamples, warnings_json } = row;

  let warnings = [];
  try { warnings = JSON.parse(warnings_json); } catch(e){}

  const failureRate = chaptersOk + chaptersFailed === 0 ? 0 : chaptersFailed / (chaptersOk + chaptersFailed);

  let healthStatus = 'green';
  if (failureRate > 0.60 || qualityScore < 0.40 && qualityScore !== -1) {
    healthStatus = 'red';
  } else if (failureRate >= 0.20 || (qualityScore >= 0.40 && qualityScore < 0.70)) {
    healthStatus = 'orange';
  }

  return {
    chaptersOk,
    chaptersFailed,
    qualityScore,
    qualitySamples,
    healthStatus,
    warnings
  };
}
