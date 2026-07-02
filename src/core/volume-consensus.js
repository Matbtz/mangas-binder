import { provider as mangaupdates } from '../providers/mangaupdates.js';
import { provider as fandom } from '../providers/fandom.js';
import { provider as anilist } from '../providers/anilist.js';
import { provider as mangabaka } from '../providers/mangabaka.js';
import { isProviderEnabled } from './settings.js';

/**
 * Cross-provider consensus for a series' total volume/chapter counts.
 *
 * Background: a real production bug showed MangaUpdates' own `latest_chapter`
 * field can be badly stale for older completed series ("20th Century Boys"
 * reported 13 despite being a finished, 249-chapter/22-volume series) while
 * its `status`-derived volume count for the same series was fine — so
 * blindly trusting a single provider's number, even MangaUpdates', isn't
 * reliable enough to gap-fill a series' chapter list against. Live-testing
 * independent sources (AniList, MangaBaka, and Fandom's wiki infobox, once
 * its own discovery bug was fixed — see providers/fandom.js) found all three
 * agree on 22/249 for that title, while only MangaUpdates disagreed.
 *
 * Rather than a fixed fallback chain, every enabled provider's opinion is
 * collected and resolved by `resolveConsensus()`: the value backed by the
 * most providers wins, so one wrong number is outvoted instead of either
 * being blindly trusted (old behavior) or blindly distrusted.
 *
 * Providers priority order (used only to break a tie between two values with
 * equal support) reflects how directly each is scoped to this exact domain:
 * MangaUpdates (community-run manga release DB) > AniList (large, actively
 * moderated manga/anime DB) > MangaBaka (newer aggregator, itself pulls from
 * the above) > Fandom (wiki markup varies per franchise; least structured).
 */
export const PROVIDER_PRIORITY = ['mangaupdates', 'anilist', 'mangabaka', 'fandom'];

/**
 * Resolve one consensus value from multiple independent providers' opinions
 * on the same metric. Groups exact-equal values together; the value backed
 * by the most providers wins. Ties in agreement count are broken by
 * `priorityOrder` (lower index = more trusted), and a further tie by the
 * higher value — under-counting a series is worse for gap-fill coverage than
 * a few extra placeholder chapters that simply fail to download if they
 * don't actually exist.
 *
 * @param {Array<{provider: string, value: number|null}>} opinions
 * @param {string[]} priorityOrder
 * @returns {{ value: number|null, confidence: number, agreeing: string[], dissenting: string[] }}
 */
export function resolveConsensus(opinions, priorityOrder = PROVIDER_PRIORITY) {
  // Providers with no opinion (e.g. AniList reporting null for a
  // still-ongoing series, correctly, rather than guessing) abstain — they
  // aren't "dissenting" from whatever the rest agree on, they just didn't vote.
  const valid = opinions.filter(o => o.value != null && Number.isFinite(o.value));
  if (!valid.length) return { value: null, confidence: 0, agreeing: [], dissenting: [] };

  const groups = new Map(); // value -> providers[]
  for (const { provider, value } of valid) {
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(provider);
  }

  const priorityIndex = p => { const i = priorityOrder.indexOf(p); return i < 0 ? Infinity : i; };
  const bestPriorityOf = providers => Math.min(...providers.map(priorityIndex));

  let best = null;
  for (const [value, providers] of groups) {
    if (!best) { best = { value, providers }; continue; }
    if (providers.length > best.providers.length) { best = { value, providers }; continue; }
    if (providers.length < best.providers.length) continue;
    const curPriority = bestPriorityOf(providers), bestPriority = bestPriorityOf(best.providers);
    if (curPriority < bestPriority) { best = { value, providers }; continue; }
    if (curPriority === bestPriority && value > best.value) best = { value, providers };
  }

  return {
    value: best.value,
    confidence: best.providers.length / valid.length,
    agreeing: best.providers,
    dissenting: valid.map(o => o.provider).filter(p => !best.providers.includes(p)),
  };
}

/**
 * Query every enabled total-volume/chapter provider for a manga series in
 * parallel and resolve a consensus for both metrics.
 *
 * @returns {Promise<{
 *   providerReports: Array<object>,        // for refresh-preview citation
 *   totalVolumes: ReturnType<typeof resolveConsensus>,
 *   totalChapters: ReturnType<typeof resolveConsensus>,
 *   mangaUpdatesRef: { seriesId, seriesTitle } | null,  // for fetchChapterVolumeMap
 * }>}
 */
export async function consultVolumeProviders(seriesTitle) {
  const providerReports = [];
  const volumeOpinions = [];
  const chapterOpinions = [];
  let mangaUpdatesRef = null;

  if (isProviderEnabled('mangaupdates')) {
    try {
      const mu = await mangaupdates.getTotalVolumesForTitle(seriesTitle);
      if (mu) {
        volumeOpinions.push({ provider: 'mangaupdates', value: mu.totalVolumes ?? null });
        chapterOpinions.push({ provider: 'mangaupdates', value: mu.latestChapter ?? null });
        mangaUpdatesRef = { seriesId: mu.seriesId, seriesTitle: mu.seriesTitle };
        providerReports.push({
          name: 'MangaUpdates', role: 'total-volume/chapter opinion & per-chapter volume overrides',
          matchedTitle: mu.seriesTitle, totalVolumes: mu.totalVolumes, totalChapters: mu.latestChapter,
        });
      } else {
        providerReports.push({ name: 'MangaUpdates', role: 'total-volume/chapter opinion & per-chapter volume overrides', error: 'no matching series found' });
      }
    } catch {
      providerReports.push({ name: 'MangaUpdates', role: 'total-volume/chapter opinion & per-chapter volume overrides', error: 'lookup failed' });
    }
  }

  const crossChecks = [
    { name: 'anilist', label: 'AniList', mod: anilist },
    { name: 'mangabaka', label: 'MangaBaka', mod: mangabaka },
    { name: 'fandom', label: 'Fandom Wiki', mod: fandom },
  ].filter(p => isProviderEnabled(p.name));

  const results = await Promise.all(crossChecks.map(async p => {
    try {
      const info = await p.mod.fetchVolumeInfo(seriesTitle);
      return { ...p, info };
    } catch {
      return { ...p, error: true };
    }
  }));

  for (const r of results) {
    const role = 'total-volume/chapter opinion (cross-check)';
    if (r.error) {
      providerReports.push({ name: r.label, role, error: 'lookup failed' });
    } else if (!r.info) {
      providerReports.push({ name: r.label, role, error: 'no verified match found' });
    } else {
      if (r.info.totalVolumes != null) volumeOpinions.push({ provider: r.name, value: r.info.totalVolumes });
      if (r.info.totalChapters != null) chapterOpinions.push({ provider: r.name, value: r.info.totalChapters });
      providerReports.push({
        name: r.label, role,
        matchedTitle: r.info.matchedTitle ?? null,
        ...(r.info.wikiUrl ? { sourceUrl: r.info.wikiUrl } : {}),
        totalVolumes: r.info.totalVolumes, totalChapters: r.info.totalChapters,
      });
    }
  }

  const totalVolumes = resolveConsensus(volumeOpinions);
  const totalChapters = resolveConsensus(chapterOpinions);

  for (const report of providerReports) {
    if (report.totalVolumes != null) report.volumesAgreesWithConsensus = report.totalVolumes === totalVolumes.value;
    if (report.totalChapters != null) report.chaptersAgreesWithConsensus = report.totalChapters === totalChapters.value;
  }

  return { providerReports, totalVolumes, totalChapters, mangaUpdatesRef };
}
