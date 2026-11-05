import { fetchJson } from '../lib/http.js';
import { round2, toNumber } from '../lib/normalize.js';
import { lastClick, skipped, type CostFetcher, type CostRow, type FeedbackSender } from './types.js';

export const META_DEFAULT_VERSION = 'v26.0';
const GRAPH = 'https://graph.facebook.com';
const PURCHASE_TYPES = ['omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'purchase'];
const MAX_PAGES = 500;
// ohne Filter fehlen archivierte und gelöschte Anzeigen, ihre Kosten verschwänden beim erneuten Import eines Tages
const AD_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'DELETED',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'PREAPPROVED',
  'PENDING_BILLING_INFO',
  'CAMPAIGN_PAUSED',
  'ARCHIVED',
  'ADSET_PAUSED',
  'IN_PROCESS',
  'WITH_ISSUES',
];

function purchaseValue(actions: any[] | undefined): number | null {
  if (!Array.isArray(actions)) return null;
  for (const type of PURCHASE_TYPES) {
    const hit = actions.find((action) => action?.action_type === type);
    if (hit) return toNumber(hit.value);
  }
  return null;
}

export const metaCosts: CostFetcher = async (ctx, settings, from, to) => {
  const version = settings.api_version || META_DEFAULT_VERSION;
  const account = String(settings.ad_account_id).replace(/^act_/, '').trim();
  const params = new URLSearchParams({
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since: from, until: to }),
    fields:
      'date_start,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,inline_link_clicks,clicks,actions,action_values,account_currency',
    filtering: JSON.stringify([{ field: 'ad.effective_status', operator: 'IN', value: AD_STATUSES }]),
    limit: '500',
    access_token: settings.access_token,
  });
  let url: string | null = `${GRAPH}/${version}/act_${account}/insights?${params}`;
  const rows: CostRow[] = [];
  for (let page = 0; url; page++) {
    // lieber abbrechen als einen Teil der Kosten zu speichern und den Rest des Zeitraums zu löschen
    if (page === MAX_PAGES) throw new Error(`Meta Insights: mehr als ${MAX_PAGES} Seiten, bitte einen kürzeren Zeitraum importieren`);
    const insights: any = await fetchJson(url, { fetchFn: ctx.fetch });
    for (const insight of insights?.data ?? []) {
      rows.push({
        date: insight.date_start,
        campaignId: String(insight.campaign_id ?? ''),
        campaignName: insight.campaign_name ?? null,
        adsetId: String(insight.adset_id ?? ''),
        adsetName: insight.adset_name ?? null,
        adId: String(insight.ad_id ?? ''),
        adName: insight.ad_name ?? null,
        spend: toNumber(insight.spend),
        impressions: toNumber(insight.impressions),
        clicks: toNumber(insight.inline_link_clicks ?? insight.clicks),
        platformConversions: purchaseValue(insight.actions),
        platformRevenue: purchaseValue(insight.action_values),
        currency: insight.account_currency ?? null,
      });
    }
    url = insights?.paging?.next ?? null;
  }
  return rows;
};

export const metaFeedback: FeedbackSender = async (ctx, settings, order) => {
  if (!settings.pixel_id) return skipped('Pixel ID fehlt');
  // client_user_agent ist für Website Events Pflicht
  if (!order.match.ua) return skipped('Ohne User Agent nimmt Meta keine Website Käufe an');
  if (Date.now() - order.createdAt.getTime() > 7 * 86_400_000) return skipped('Kauf älter als 7 Tage');
  const version = settings.api_version || META_DEFAULT_VERSION;
  const click = lastClick(order, ['fbclid'], 90);
  const fbc = order.match.fbc ?? (click ? `fb.1.${click.ts}.${click.clickId}` : null);
  const userData: Record<string, unknown> = {};
  if (order.emailHash) userData.em = [order.emailHash];
  if (order.phoneHash) userData.ph = [order.phoneHash];
  if (order.externalIdHash) userData.external_id = [order.externalIdHash];
  if (order.match.ip) userData.client_ip_address = order.match.ip;
  if (order.match.ua) userData.client_user_agent = order.match.ua;
  if (fbc) userData.fbc = fbc;
  if (order.match.fbp) userData.fbp = order.match.fbp;
  if (!userData.em && !userData.ph && !fbc && !userData.fbp && !(userData.client_ip_address && userData.client_user_agent)) {
    return skipped('Keine Merkmale für den Abgleich');
  }
  const body: Record<string, unknown> = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(order.createdAt.getTime() / 1000),
        event_id: order.externalId,
        action_source: 'website',
        event_source_url: order.match.url ?? order.landingUrl ?? undefined,
        user_data: userData,
        custom_data: {
          currency: order.currency,
          value: round2(order.value),
          order_id: order.externalId,
          content_type: 'product',
          contents: order.items.map((lineItem) => ({
            id: lineItem.sku || lineItem.id || lineItem.name,
            quantity: lineItem.quantity,
            item_price: lineItem.price,
          })),
          num_items: order.items.reduce((sum, lineItem) => sum + lineItem.quantity, 0),
        },
      },
    ],
    access_token: settings.access_token,
  };
  if (settings.test_event_code) body.test_event_code = settings.test_event_code;
  const response = await fetchJson(`${GRAPH}/${version}/${settings.pixel_id}/events`, { method: 'POST', body, fetchFn: ctx.fetch });
  return { status: 'sent', response: JSON.stringify(response).slice(0, 500) };
};
