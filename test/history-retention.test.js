import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The audit/history log is append-only; without retention it grew without
// bound on a long-running server (DB file, WAL, page cache) — and every write
// is a synchronous SQLite call on the event loop. Verify it self-trims.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-history-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');

const { logHistory, pruneHistory, getDb } = await import('../src/core/db.js');
const { recentHistory } = await import('../src/core/repo.js');
const { closeDb } = await import('../src/core/db.js');

after(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); });

const historyCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM history').get().n;

test('logHistory amortised retention keeps the table bounded to the newest ~HISTORY_KEEP rows', () => {
  // Default keep is 5000, pruned every 500 inserts. Write well past the cap.
  for (let i = 0; i < 6100; i++) logHistory('test.event', { message: `row ${i}` });
  const n = historyCount();
  // Bounded to the cap plus at most one un-pruned prune-window (500).
  assert.ok(n <= 5000 + 500, `expected history bounded near 5000, got ${n}`);
  assert.ok(n >= 5000, `expected at least the retained window, got ${n}`);

  // The rows kept are the newest ones (most recent message survives).
  const newest = recentHistory(1)[0];
  assert.equal(newest.message, 'row 6099');
});

test('pruneHistory trims to an explicit cap and reports the delete count', () => {
  const before = historyCount();
  const deleted = pruneHistory(100);
  assert.equal(historyCount(), 100);
  assert.equal(deleted, before - 100);
  // A second prune to the same cap is a no-op.
  assert.equal(pruneHistory(100), 0);
});
