import { provider as mangaupdates } from '../providers/mangaupdates.js';
import { provider as fandom } from '../providers/fandom.js';
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
 * reliable enough to gap-fill a series' chapter list against. Independent
 * sources (MangaBaka and Fandom's wiki infobox) agree on 22/249 for that
 * title, while only MangaUpdates disagreed.
 *
 * Rather than a fixed fallback chain, every enabled provider's opinion is
 * collected and resolved by `resolveConsensus()`: the value backed by the
 * most providers wins, so one wrong number is outvoted instead of either
 * being blindly trusted (old behavior) or blindly distrusted.
 *
 * Pure vote-counting isn't enough on its own, though: a value can be backed by
 * several providers yet still be physically impossible (a real case: "Pet",
 * a finished 5-volume/55-chapter series, was reported as 1 volume by two
 * providers — 55 chapters can't fit in one volume). So before voting we
 * discard opinions that are internally
 * inconsistent (a single provider's own volume/chapter pair implies an
 * impossible chapters-per-volume) and cross-validate volume counts against the
 * resolved chapter total (see consultVolumeProviders). That lets a correct
 * lone MangaBaka (5 vols / 55 chs) beat a "1 volume" claim two providers share.
 *
 * Providers priority order (used only to break a tie between two values with
 * equal support) reflects how directly each is scoped to this exact domain:
 * MangaUpdates (community-run manga release DB) > MangaBaka (aggregator that
 * itself pulls from AniList/MAL/MangaUpdates) > Fandom (wiki markup varies per
 * franchise; least structured).
 */
export const PROVIDER_PRIORITY = ['mangaupdates', 'mangabaka', 'fandom'];

// A tankōbon volume realistically collects a handful to a few dozen chapters.
// A ratio outside this band means one of the two numbers is wrong for THIS
// series (e.g. a stale latest_chapter of 13 against 13 volumes → 1 ch/vol, or
// a "1 volume" claim against 55 chapters → 55 ch/vol). The band is deliberately
// generous so it only rejects the physically impossible, never a merely
// unusual-but-real distribution.
const MIN_CHS_PER_VOL = 2;
const MAX_CHS_PER_VOL = 40;

/**
 * True when a (volumes, chapters) pair implies an impossible chapters-per-
 * volume. Used both to reject a single provider's self-contradictory pair and
 * to reject a volume opinion against the resolved chapter consensus. Returns
 * false whenever either side is missing — an unknown can't contradict anything.
 */
export function impliesImpossibleChaptersPerVolume(volumes, chapters) {
  if (!(volumes > 0) || !(chapters > 0)) return false;
  const ratio = chapters / volumes;
  return ratio < MIN_CHS_PER_VOL || ratio > MAX_CHS_PER_VOL;
}

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
  // Providers with no opinion (e.g. a provider that returns null for a
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
  const volumeOpinions = [];   // { provider, value }
  const chapterOpinions = [];
  const pairByProvider = new Map(); // provider -> { volumes, chapters }
  let mangaUpdatesRef = null;

  const recordPair = (provider, volumes, chapters) => {
    if (volumes != null) volumeOpinions.push({ provider, value: volumes });
    if (chapters != null) chapterOpinions.push({ provider, value: chapters });
    pairByProvider.set(provider, { volumes: volumes ?? null, chapters: chapters ?? null });
  };

  if (isProviderEnabled('mangaupdates')) {
    try {
      const mu = await mangaupdates.getTotalVolumesForTitle(seriesTitle);
      if (mu) {
        recordPair('mangaupdates', mu.totalVolumes ?? null, mu.latestChapter ?? null);
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
      recordPair(r.name, r.info.totalVolumes ?? null, r.info.totalChapters ?? null);
      providerReports.push({
        name: r.label, role,
        matchedTitle: r.info.matchedTitle ?? null,
        ...(r.info.wikiUrl ? { sourceUrl: r.info.wikiUrl } : {}),
        totalVolumes: r.info.totalVolumes, totalChapters: r.info.totalChapters,
      });
    }
  }

  // 1. Internal-consistency filter: a provider that reports BOTH a volume and a
  //    chapter count whose ratio is physically impossible (MangaUpdates' stale
  //    latest_chapter giving 13 chapters for a 13-volume series → 1 ch/vol) is
  //    self-contradictory for THIS series, so drop *both* of its votes. It
  //    stays in the report, flagged, so the preview shows why it was set aside.
  const inconsistent = new Set();
  for (const [provider, { volumes, chapters }] of pairByProvider) {
    if (impliesImpossibleChaptersPerVolume(volumes, chapters)) inconsistent.add(provider);
  }
  // Never filter down to nothing: a lone questionable number still beats having
  // no gap-fill coverage at all, so the drop only applies when something remains.
  const keepVolumes = volumeOpinions.filter(o => !inconsistent.has(o.provider));
  const keepChapters = chapterOpinions.filter(o => !inconsistent.has(o.provider));
  const consistentVolumes = keepVolumes.length ? keepVolumes : volumeOpinions;
  const consistentChapters = keepChapters.length ? keepChapters : chapterOpinions;

  // 2. Resolve chapters first, then reject any volume count that would imply an
  //    impossible chapters-per-volume against it, and resolve volumes among the
  //    survivors. This is what lets MangaBaka's correct 5 volumes beat a "1
  //    volume" claim that other providers share (55 chapters / 1 volume is out
  //    of band; 55 / 5 = 11 is fine).
  const totalChapters = resolveConsensus(consistentChapters);
  let volumeCandidates = consistentVolumes;
  const rejectedVolumeProviders = new Set();
  if (totalChapters.value) {
    const plausible = consistentVolumes.filter(o => !impliesImpossibleChaptersPerVolume(o.value, totalChapters.value));
    if (plausible.length) {
      for (const o of consistentVolumes) if (!plausible.includes(o)) rejectedVolumeProviders.add(o.provider);
      volumeCandidates = plausible;
    }
  }
  const totalVolumes = resolveConsensus(volumeCandidates);

  for (const report of providerReports) {
    const provider = REPORT_NAME_TO_PROVIDER[report.name];
    if (provider && inconsistent.has(provider)) report.rejectedAsInconsistent = true;
    if (provider && rejectedVolumeProviders.has(provider)) report.rejectedVolumeAsImplausible = true;
    if (report.totalVolumes != null) report.volumesAgreesWithConsensus = report.totalVolumes === totalVolumes.value;
    if (report.totalChapters != null) report.chaptersAgreesWithConsensus = report.totalChapters === totalChapters.value;
  }

  return { providerReports, totalVolumes, totalChapters, mangaUpdatesRef };
}

const REPORT_NAME_TO_PROVIDER = {
  'MangaUpdates': 'mangaupdates',
  'MangaBaka': 'mangabaka',
  'Fandom Wiki': 'fandom',
};
