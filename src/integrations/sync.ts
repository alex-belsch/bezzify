import type { Db, Queryable } from '../db/index.js';
import { errMsg, log } from '../lib/log.js';
import { addDays, zonedDay } from '../lib/time.js';
import type { FetchFn } from '../lib/http.js';
import { listAllSites, type Site } from '../sites.js';
import { awinCosts } from './awin.js';
import { googleCosts } from './google.js';
import { metaCosts } from './meta.js';
import { pinterestCosts } from './pinterest.js';
import { platformDef } from './registry.js';
import { getIntegration, listIntegrations, markSync, missingRequired, redactSecrets } from './store.js';
import { tiktokCosts } from './tiktok.js';
import type { CostFetcher, CostRow } from './types.js';

export const COST_FETCHERS: Record<string, CostFetcher> = {
  meta: metaCosts,
  google_ads: googleCosts,
  tiktok: tiktokCosts,
  pinterest: pinterestCosts,
  awin: awinCosts,
};

// Pinterest wertet nur die letzten 90 Tage (UTC) aus, der Zeitraum wird hier gekürzt, weil writeCosts ihn ganz ersetzt
const MAX_LOOKBACK_DAYS: Record<string, number> = { pinterest: 89 };

const INSERT_COLUMNS = [
  'site_id',
  'date',
  'platform',
  'channel',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'spend',
  'impressions',
  'clicks',
  'platform_conversions',
  'platform_revenue',
  'currency',
];

export async function writeCosts(q: Queryable, site: Site, platform: string, from: string, to: string, rows: CostRow[]) {
  const channel = platformDef(platform)?.channel ?? platform;
  // gleiche Schlüssel zusammenfassen, damit der Primärschlüssel eindeutig bleibt
  const merged = new Map<string, CostRow>();
  for (const row of rows) {
    if (!row.date || row.date < from || row.date > to) continue;
    const key = [row.date, row.campaignId, row.adsetId, row.adId].join('|');
    const existing = merged.get(key);
    if (!existing) merged.set(key, { ...row });
    else {
      existing.spend += row.spend;
      existing.impressions += row.impressions;
      existing.clicks += row.clicks;
      existing.platformConversions = (existing.platformConversions ?? 0) + (row.platformConversions ?? 0);
      existing.platformRevenue = (existing.platformRevenue ?? 0) + (row.platformRevenue ?? 0);
    }
  }
  const list = [...merged.values()];
  await q.query('delete from costs where site_id = $1 and platform = $2 and date >= $3::date and date <= $4::date', [
    site.id,
    platform,
    from,
    to,
  ]);
  const width = INSERT_COLUMNS.length;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const params: unknown[] = [];
    const tuples = chunk.map((row, j) => {
      params.push(
        site.id,
        row.date,
        platform,
        channel,
        row.campaignId ?? '',
        row.campaignName,
        row.adsetId ?? '',
        row.adsetName,
        row.adId ?? '',
        row.adName,
        row.spend,
        Math.round(row.impressions),
        Math.round(row.clicks),
        row.platformConversions ?? null,
        row.platformRevenue ?? null,
        row.currency ?? null,
      );
      return `(${Array.from({ length: width }, (_, k) => `$${j * width + k + 1}`).join(',')})`;
    });
    await q.query(`insert into costs (${INSERT_COLUMNS.join(', ')}) values ${tuples.join(',')}`, params);
  }
  return list.length;
}

export interface SyncResult {
  platform: string;
  rows?: number;
  error?: string;
  from?: string;
  to?: string;
}

export async function syncCosts(
  q: Db,
  site: Site,
  platform: string,
  opts: { from?: string; to?: string; fetchFn?: FetchFn } = {},
): Promise<SyncResult> {
  const fetcher = COST_FETCHERS[platform];
  if (!fetcher) return { platform, error: 'Plattform liefert keine Kosten' };
  const integration = await getIntegration(q, site.id, platform);
  if (!integration || !integration.enabled) return { platform, error: 'nicht eingerichtet' };
  const missing = missingRequired(platform, integration.values);
  if (missing.length) {
    const error = `Es fehlen: ${missing.join(', ')}`;
    await markSync(q, site.id, platform, error);
    return { platform, error };
  }
  const to = opts.to ?? zonedDay(Date.now(), site.timezone);
  let from = opts.from ?? addDays(to, integration.lastSyncAt ? -3 : -30);
  const lookback = MAX_LOOKBACK_DAYS[platform];
  if (lookback) {
    const earliest = addDays(zonedDay(Date.now(), 'UTC'), -lookback);
    if (from < earliest) from = earliest;
  }
  try {
    const rows = await fetcher({ fetch: opts.fetchFn ?? fetch, site }, integration.values, from, to);
    const written = await q.tx((tx) => writeCosts(tx, site, platform, from, to, rows));
    await markSync(q, site.id, platform, null);
    log.info('Kosten importiert', { site: site.id, platform, rows: written, from, to });
    return { platform, rows: written, from, to };
  } catch (e) {
    const error = redactSecrets(platform, integration.values, errMsg(e)).slice(0, 1000);
    await markSync(q, site.id, platform, error);
    log.warn('Kostenimport fehlgeschlagen', { site: site.id, platform, error });
    return { platform, error, from, to };
  }
}

export async function syncAllCosts(q: Db): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const site of await listAllSites(q)) {
    for (const integration of await listIntegrations(q, site.id)) {
      if (!integration.enabled || !COST_FETCHERS[integration.platform]) continue;
      results.push(await syncCosts(q, site, integration.platform));
    }
  }
  return results;
}
