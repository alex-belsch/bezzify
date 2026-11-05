import { fetchJson } from '../lib/http.js';
import { round2, toNumber } from '../lib/normalize.js';
import { chunkDays, lastClick, skipped, type ConnectorCtx, type CostFetcher, type CostRow, type FeedbackSender } from './types.js';

const BASE = 'https://api.pinterest.com/v5';
const MAX_PAGES = 200;

// ohne Angabe liefert die API nur aktive und pausierte Objekte, Kosten archivierter Anzeigen fehlten sonst
const ENTITY_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'];

async function listEntities(ctx: ConnectorCtx, token: string, path: string): Promise<any[]> {
  const entities: any[] = [];
  let bookmark: string | null = null;
  for (let page = 0; ; page++) {
    // lieber abbrechen als einen Teil der Kosten zu speichern und den Rest des Zeitraums zu löschen
    if (page === MAX_PAGES) throw new Error(`Pinterest ${path}: mehr als ${MAX_PAGES} Seiten`);
    const params = new URLSearchParams({ page_size: '250' });
    // Arrays laut OpenAPI Beschreibung als wiederholte Parameter
    for (const status of ENTITY_STATUSES) params.append('entity_statuses', status);
    if (bookmark) params.set('bookmark', bookmark);
    const listing: any = await fetchJson(`${BASE}${path}?${params}`, { headers: { authorization: `Bearer ${token}` }, fetchFn: ctx.fetch });
    entities.push(...(listing?.items ?? []));
    bookmark = listing?.bookmark ?? null;
    if (!bookmark) return entities;
  }
}

export const pinterestCosts: CostFetcher = async (ctx, settings, from, to) => {
  const account = String(settings.ad_account_id).trim();
  const token = settings.access_token;
  const [campaigns, groups, ads] = await Promise.all([
    listEntities(ctx, token, `/ad_accounts/${account}/campaigns`),
    listEntities(ctx, token, `/ad_accounts/${account}/ad_groups`),
    listEntities(ctx, token, `/ad_accounts/${account}/ads`),
  ]);
  const campaignName = new Map(campaigns.map((campaign) => [String(campaign.id), campaign.name ?? null]));
  const groupName = new Map(groups.map((group) => [String(group.id), group.name ?? null]));
  const adInfo = new Map(ads.map((ad) => [String(ad.id), ad]));
  const rows: CostRow[] = [];
  const adIds = [...adInfo.keys()];
  for (const [start, end] of chunkDays(from, to, 89)) {
    for (let i = 0; i < adIds.length; i += 250) {
      const params = new URLSearchParams({
        start_date: start,
        end_date: end,
        // columns ist laut Beschreibung kommagetrennt, ad_ids wiederholt
        columns: 'SPEND_IN_MICRO_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1,TOTAL_CHECKOUT,TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR',
        granularity: 'DAY',
      });
      for (const adId of adIds.slice(i, i + 250)) params.append('ad_ids', adId);
      const analytics: any = await fetchJson(`${BASE}/ad_accounts/${account}/ads/analytics?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        fetchFn: ctx.fetch,
      });
      for (const stats of Array.isArray(analytics) ? analytics : []) {
        const adId = String(stats.AD_ID ?? '');
        const ad = adInfo.get(adId) ?? {};
        const campaignId = String(stats.CAMPAIGN_ID ?? ad.campaign_id ?? '');
        const groupId = String(stats.AD_GROUP_ID ?? ad.ad_group_id ?? '');
        rows.push({
          date: String(stats.DATE ?? '').slice(0, 10),
          campaignId,
          campaignName: campaignName.get(campaignId) ?? null,
          adsetId: groupId,
          adsetName: groupName.get(groupId) ?? null,
          adId,
          adName: ad.name ?? null,
          spend: toNumber(stats.SPEND_IN_MICRO_DOLLAR) / 1e6,
          impressions: toNumber(stats.IMPRESSION_1),
          clicks: toNumber(stats.CLICKTHROUGH_1),
          platformConversions: stats.TOTAL_CHECKOUT !== undefined ? toNumber(stats.TOTAL_CHECKOUT) : null,
          platformRevenue:
            stats.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR !== undefined ? toNumber(stats.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR) / 1e6 : null,
        });
      }
    }
  }
  return rows.filter((row) => row.date && (row.spend > 0 || row.impressions > 0));
};

export const pinterestFeedback: FeedbackSender = async (ctx, settings, order) => {
  if (!settings.conversion_token) return skipped('Conversion Token fehlt');
  const click = lastClick(order, ['epik'], 30);
  const userData: Record<string, unknown> = {};
  if (order.emailHash) userData.em = [order.emailHash];
  if (order.phoneHash) userData.ph = [order.phoneHash];
  if (order.externalIdHash) userData.external_id = [order.externalIdHash];
  if (order.match.ip) userData.client_ip_address = order.match.ip;
  if (order.match.ua) userData.client_user_agent = order.match.ua;
  const epik = click?.clickId ?? order.match.epik;
  if (epik) userData.click_id = epik;
  if (!userData.em && !(userData.client_ip_address && userData.client_user_agent)) {
    return skipped('Pinterest braucht Mailadresse oder IP und User Agent');
  }
  const body = {
    data: [
      {
        event_name: 'checkout',
        action_source: 'web',
        event_time: Math.floor(order.createdAt.getTime() / 1000),
        event_id: order.externalId,
        event_source_url: order.match.url ?? order.landingUrl ?? undefined,
        // ohne Marketing Einwilligung nur zur Messung, nicht zur Personalisierung
        opt_out: order.consentMarketing === false,
        user_data: userData,
        custom_data: {
          currency: order.currency,
          value: String(round2(order.value)),
          order_id: order.externalId,
          num_items: order.items.reduce((sum, lineItem) => sum + lineItem.quantity, 0),
          content_ids: order.items.map((lineItem) => lineItem.sku || lineItem.id).filter(Boolean),
        },
      },
    ],
  };
  const test = settings.test_mode ? '?test=true' : '';
  const response = await fetchJson(`${BASE}/ad_accounts/${String(settings.ad_account_id).trim()}/events${test}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.conversion_token}` },
    body,
    fetchFn: ctx.fetch,
  });
  return { status: 'sent', response: JSON.stringify(response).slice(0, 500) };
};
