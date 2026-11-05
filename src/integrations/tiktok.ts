import { fetchJson } from '../lib/http.js';
import { round2, toNumber } from '../lib/normalize.js';
import { chunkDays, lastClick, skipped, type CostFetcher, type CostRow, type FeedbackSender } from './types.js';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const MAX_PAGES = 200;

function unwrap(response: any): any {
  if (!response || response.code !== 0) throw new Error(`TikTok API: ${response?.code ?? '?'} ${response?.message ?? 'ohne Antwort'}`);
  return response.data;
}

export const tiktokCosts: CostFetcher = async (ctx, settings, from, to) => {
  const rows: CostRow[] = [];
  // mit Tagesaufteilung erlaubt die API höchstens 30 Tage je Abfrage
  for (const [start, end] of chunkDays(from, to, 30)) {
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({
        advertiser_id: String(settings.advertiser_id),
        report_type: 'BASIC',
        data_level: 'AUCTION_AD',
        dimensions: JSON.stringify(['ad_id', 'stat_time_day']),
        metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'campaign_id', 'campaign_name', 'adgroup_id', 'adgroup_name', 'ad_name']),
        start_date: start,
        end_date: end,
        // Standard ist STATUS_NOT_DELETE, Kosten gelöschter Anzeigen fehlten sonst
        filtering: JSON.stringify([{ field_name: 'ad_status', filter_type: 'IN', filter_value: '["STATUS_ALL"]' }]),
        page: String(page),
        page_size: '1000',
      });
      const report = unwrap(
        await fetchJson(`${BASE}/report/integrated/get/?${params}`, {
          headers: { 'Access-Token': settings.access_token },
          fetchFn: ctx.fetch,
        }),
      );
      for (const entry of report?.list ?? []) {
        const dimensions = entry.dimensions ?? {};
        const metrics = entry.metrics ?? {};
        rows.push({
          date: String(dimensions.stat_time_day ?? '').slice(0, 10),
          campaignId: String(metrics.campaign_id ?? ''),
          campaignName: metrics.campaign_name ?? null,
          adsetId: String(metrics.adgroup_id ?? ''),
          adsetName: metrics.adgroup_name ?? null,
          adId: String(dimensions.ad_id ?? ''),
          adName: metrics.ad_name ?? null,
          spend: toNumber(metrics.spend),
          impressions: toNumber(metrics.impressions),
          clicks: toNumber(metrics.clicks),
        });
      }
      if (page >= toNumber(report?.page_info?.total_page)) break;
      // lieber abbrechen als einen Teil der Kosten zu speichern und den Rest des Zeitraums zu löschen
      if (page === MAX_PAGES) throw new Error(`TikTok Report: mehr als ${MAX_PAGES} Seiten, bitte einen kürzeren Zeitraum importieren`);
    }
  }
  return rows.filter((row) => row.date);
};

export const tiktokFeedback: FeedbackSender = async (ctx, settings, order) => {
  if (!settings.pixel_code || !settings.events_access_token) return skipped('Pixel Code oder Events Token fehlt');
  const click = lastClick(order, ['ttclid'], 28);
  const user: Record<string, unknown> = {};
  if (order.emailHash) user.email = order.emailHash;
  if (order.match.phE164) user.phone = order.match.phE164;
  if (order.externalIdHash) user.external_id = order.externalIdHash;
  if (click?.clickId) user.ttclid = click.clickId;
  if (order.match.ttp) user.ttp = order.match.ttp;
  if (order.match.ip) user.ip = order.match.ip;
  if (order.match.ua) user.user_agent = order.match.ua;
  if (!user.email && !user.phone && !user.ttclid && !user.ttp) return skipped('Keine Merkmale für den Abgleich');
  const body: Record<string, unknown> = {
    event_source: 'web',
    event_source_id: settings.pixel_code,
    data: [
      {
        event: 'Purchase',
        event_time: Math.floor(order.createdAt.getTime() / 1000),
        event_id: order.externalId,
        user,
        properties: {
          currency: order.currency,
          value: round2(order.value),
          order_id: order.externalId,
          content_type: 'product',
          contents: order.items.map((lineItem) => ({
            content_id: lineItem.sku || lineItem.id || lineItem.name,
            content_name: lineItem.name,
            quantity: lineItem.quantity,
            price: lineItem.price,
          })),
        },
        page: { url: order.match.url ?? order.landingUrl ?? undefined },
      },
    ],
  };
  if (settings.test_event_code) body.test_event_code = settings.test_event_code;
  const response = await fetchJson(`${BASE}/event/track/`, {
    method: 'POST',
    headers: { 'Access-Token': settings.events_access_token },
    body,
    fetchFn: ctx.fetch,
  });
  unwrap(response);
  return { status: 'sent', response: JSON.stringify(response).slice(0, 500) };
};
