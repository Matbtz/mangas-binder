import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// previewRefreshSeries() is the read-only "dry run" behind the refresh-preview
// modal: it must fetch exactly what refreshSeries() would, cite which provider
// supplied which value, diff against the DB, and simulate the same
// extrapolation resolveVolumes() would apply — all without writing anything.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-refreshpreview-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.OUTPUT_DIR = path.join(tmp, 'out');
process.env.STAGING_DIR = path.join(tmp, 'staging');
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/server/app.js');
const { setSetting } = await import('../src/core/settings.js');
const { createSeries, upsertChapter, listChaptersForSeries, setChapterState } = await import('../src/core/repo.js');
const { previewRefreshSeries } = await import('../src/core/series-service.js');
const { closeDb } = await import('../src/core/db.js');

const app = await buildApp();
setSetting('downloadsPaused', true);

const realFetch = global.fetch;
function mockProvidersFor(chapterVolumes, { totalVolumes = 10, latestChapter = null, muReleases = new Map(), crossChecks = {} } = {}) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('mangadex.org') && u.includes('/aggregate')) return { ok: true, status: 200, json: async () => ({ volumes: {} }) };
    if (u.includes('mangadex.org') && u.includes('/feed')) {
      const data = Object.entries(chapterVolumes).map(([num, vol]) => ({
        id: `c${num}`,
        attributes: { chapter: num, volume: vol, translatedLanguage: 'en', pages: 20, publishAt: null },
      }));
      return { ok: true, status: 200, json: async () => ({ total: data.length, data }) };
    }
    if (u.includes('mangaupdates.com') && u.includes('series/search')) {
      return { ok: true, status: 200, json: async () => ({ results: [{ record: { series_id: 999, title: 'Preview Series', url: '' } }] }) };
    }
    if (u.includes('mangaupdates.com') && u.includes('/series/999')) {
      return { ok: true, status: 200, json: async () => ({ status: `${totalVolumes} Volumes (Ongoing)`, latest_chapter: latestChapter ? String(latestChapter) : null }) };
    }
    if (u.includes('mangaupdates.com') && u.includes('releases/search')) {
      const results = [...muReleases.entries()].map(([ch, vol]) => ({ record: { chapter: ch, volume: vol } }));
      return { ok: true, status: 200, json: async () => ({ results }) };
    }
    // AniList/MangaBaka cross-checks, only wired up when a test explicitly
    // provides one via `crossChecks` — otherwise they fall through to the
    // catch-all below, matching current real-world behavior when a provider
    // has no verified match.
    if (u.includes('graphql.anilist.co')) {
      const c = crossChecks.anilist;
      const media = c ? { title: { romaji: c.title, english: null }, volumes: c.volumes ?? null, chapters: c.chapters ?? null, status: c.status || 'FINISHED' } : null;
      return { ok: true, status: 200, json: async () => ({ data: { Media: media } }) };
    }
    if (u.includes('api.mangabaka.dev') && u.includes('/series/search')) {
      const c = crossChecks.mangabaka;
      return { ok: true, status: 200, json: async () => ({ data: c ? [{ id: 1, title: c.title }] : [] }) };
    }
    if (u.includes('api.mangabaka.dev') && u.includes('/series/1')) {
      const c = crossChecks.mangabaka;
      return { ok: true, status: 200, json: async () => ({ data: c ? { id: 1, title: c.title, status: c.status || 'completed', final_volume: c.volumes != null ? String(c.volumes) : null, total_chapters: c.chapters ?? null } : null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}
after(async () => { global.fetch = realFetch; await app.close(); closeDb(); rmSync(tmp, { recursive: true, force: true }); });

test('previewRefreshSeries: cites both providers and reports new/changed/estimated chapters without writing to the DB', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pv1', title: 'Preview Series', language: 'en', monitored: true, packagingMode: 'volume' });
  const chapterVolumes = {};
  for (let i = 1; i <= 14; i++) chapterVolumes[String(i)] = i <= 7 ? '1' : '2';
  mockProvidersFor(chapterVolumes, { totalVolumes: 10, latestChapter: 40 });

  const report = await previewRefreshSeries(s.id);

  assert.equal(report.providersConsulted.some(p => p.name === 'MangaDex'), true);
  assert.equal(report.providersConsulted.some(p => p.name === 'MangaUpdates'), true);
  assert.equal(report.mangaUpdates.totalVolumesHint, 10);
  // 40 chapters known via the MU latestChapter gap-fill, only 14 tagged directly
  assert.equal(report.summary.incomingChapterCount, 40);
  assert.equal(report.mangaUpdates.gapFilledChapters, 26);
  assert.ok(report.summary.estimatedVolumeCount > 0);

  // Nothing should have been written to the DB by a preview.
  assert.equal(listChaptersForSeries(s.id).length, 0);
});

test('previewRefreshSeries: flags a volume-tag conflict for an already-packaged chapter as protected, not a plain change', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pv2', title: 'Preview Series Two', language: 'en', monitored: true, packagingMode: 'volume' });
  for (const n of ['1', '2', '3']) upsertChapter(s.id, { provider: 'mangadex', number: n, volume: '1' });
  const ch1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  setChapterState(ch1.id, 'imported', { volume: '1', calculated: 0, cbz_path: '/tmp/fake.cbz' });

  // Provider now (incorrectly) reports chapter 1 as volume 2.
  mockProvidersFor({ '1': '2', '2': '1', '3': '1' }, { totalVolumes: null });

  const report = await previewRefreshSeries(s.id);
  assert.equal(report.protectedSkipped.length, 1);
  assert.equal(report.protectedSkipped[0].number, '1');
  assert.equal(report.protectedSkipped[0].dbVolume, '1');
  assert.equal(report.protectedSkipped[0].providerVolume, '2');
  assert.equal(report.volumeChanges.length, 0);

  // Still nothing written.
  const after1 = listChaptersForSeries(s.id).find(c => c.number === '1');
  assert.equal(after1.volume, '1');
  assert.equal(after1.state, 'imported');
});

test('previewRefreshSeries: volumeBreakdown does not double-count a demoted noisy chapter under both its rejected and corrected volume', async () => {
  // Chapters 1-10 are a clean volume-1 cluster; chapter 500 is a wildly
  // mistagged "volume 1" outlier (e.g. a scanlation group's bad tag) that
  // sanitizeVolumeMap()'s per-chapter outlier check demotes back to noisy so
  // extrapolateVolumes() can re-place it at a sane estimated volume instead.
  // volumeBreakdown must reflect the *sanitized* count for volume 1 (10, not
  // 11) and must not also double-count chapter 500 under whatever volume it
  // gets re-estimated into on top of its original bad tag.
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pv4', title: 'Preview Series Four', language: 'en', monitored: true, packagingMode: 'volume' });
  const chapterVolumes = {};
  for (let i = 1; i <= 10; i++) chapterVolumes[String(i)] = '1';
  chapterVolumes['500'] = '1'; // mistagged outlier
  mockProvidersFor(chapterVolumes, { totalVolumes: null });

  const report = await previewRefreshSeries(s.id);

  assert.ok(report.noisyChapters.includes('500'));
  assert.equal(report.volumeBreakdown['1'], 10);
  const totalChapters = Object.values(report.volumeBreakdown).reduce((a, b) => a + b, 0);
  assert.equal(totalChapters, 11); // 10 clean + 1 re-estimated chapter 500, not 12
});

test('previewRefreshSeries: when MangaUpdates disagrees with the other providers, the majority consensus is used for gap-filling', async () => {
  // Reproduces the real "20th Century Boys" bug: MangaUpdates' own
  // latest_chapter was stale (13) for a finished series that AniList and
  // MangaBaka both correctly reported as 249 chapters / 22 volumes. The
  // resolved consensus — not MangaUpdates alone — must drive gap-filling.
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pv5', title: 'Preview Series', language: 'en', monitored: true, packagingMode: 'volume' });
  mockProvidersFor({ '1': '1' }, {
    totalVolumes: 13, // MangaUpdates' status field also lowballs it here
    latestChapter: 13,
    crossChecks: {
      anilist: { title: 'Preview Series', volumes: 22, chapters: 249, status: 'FINISHED' },
      mangabaka: { title: 'Preview Series', volumes: 22, chapters: 249, status: 'completed' },
    },
  });

  const report = await previewRefreshSeries(s.id);

  assert.equal(report.mangaUpdates.latestChapterHint, 249);
  assert.equal(report.mangaUpdates.totalVolumesHint, 22);
  assert.deepEqual(report.mangaUpdates.latestChapterDissenting, ['mangaupdates']);
  assert.equal(report.summary.incomingChapterCount, 249); // gap-filled to the consensus value, not MU's stale 13
  assert.ok(report.providersConsulted.some(p => p.name === 'AniList' && p.totalChapters === 249));
  assert.ok(report.providersConsulted.some(p => p.name === 'MangaBaka' && p.totalChapters === 249));
  assert.ok(report.providersConsulted.some(p => p.name === 'Consensus' && p.latestChapterHint === 249));
});

test('previewRefreshSeries: with only MangaUpdates answering, its lone opinion is still used (no other providers to outvote it)', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pv6', title: 'Preview Series', language: 'en', monitored: true, packagingMode: 'volume' });
  mockProvidersFor({ '1': '1' }, { totalVolumes: 13, latestChapter: 13 });

  const report = await previewRefreshSeries(s.id);
  assert.equal(report.mangaUpdates.latestChapterHint, 13);
  assert.equal(report.mangaUpdates.latestChapterConfidence, 1);
});

test('previewRefreshSeries: a transient MangaUpdates failure is reported as "lookup failed", not misreported as "no matching series found", and the other providers still resolve a consensus', async () => {
  // Reproduces a real production report: MangaUpdates errored out on a
  // lookup for a series (Dandadan) confirmed live to actually be in its
  // database, most likely a momentary timeout/rate-limit under concurrent
  // refresh load — and the report labeled it "no matching series found",
  // which is misleading (it implies MangaUpdates was reached and searched,
  // not that the request itself failed).
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pv7', title: 'Preview Series', language: 'en', monitored: true, packagingMode: 'volume' });
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('mangadex.org') && u.includes('/aggregate')) return { ok: true, status: 200, json: async () => ({ volumes: {} }) };
    if (u.includes('mangadex.org') && u.includes('/feed')) return { ok: true, status: 200, json: async () => ({ total: 0, data: [] }) };
    if (u.includes('mangaupdates.com')) throw new Error('ETIMEDOUT'); // keeps failing through every retry
    if (u.includes('graphql.anilist.co')) {
      return { ok: true, status: 200, json: async () => ({ data: { Media: { title: { romaji: 'Preview Series', english: null }, volumes: 24, chapters: 239, status: 'RELEASING' } } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const report = await previewRefreshSeries(s.id);

  const muReport = report.providersConsulted.find(p => p.name === 'MangaUpdates');
  assert.equal(muReport.error, 'lookup failed');
  assert.notEqual(muReport.error, 'no matching series found');

  // MangaUpdates being unreachable must not block a consensus from the
  // providers that did answer.
  assert.equal(report.mangaUpdates.totalVolumesHint, 24);
  assert.equal(report.mangaUpdates.latestChapterHint, 239);
});

test('GET /api/series/:id/refresh-preview returns the same report shape over HTTP', async () => {
  const s = createSeries({ provider: 'mangadex', providerSeriesId: 'pv3', title: 'Preview Series Three', language: 'en', monitored: true, packagingMode: 'volume' });
  mockProvidersFor({ '1': '1', '2': '1' }, { totalVolumes: null });

  const res = await app.inject({ method: 'GET', url: `/api/series/${s.id}/refresh-preview` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.seriesTitle, 'Preview Series Three');
  assert.ok(Array.isArray(body.providersConsulted));
});
