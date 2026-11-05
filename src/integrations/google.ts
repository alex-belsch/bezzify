import { fetchJson } from '../lib/http.js';
import { round2, toNumber } from '../lib/normalize.js';
import { googleDateTime } from '../lib/time.js';
import { lastClick, skipped, type ConnectorCtx, type CostFetcher, type CostRow, type FeedbackSender } from './types.js';

export const GOOGLE_DEFAULT_VERSION = 'v26';
const digits = (id: unknown) => String(id ?? '').replace(/\D/g, '');

async function accessToken(ctx: ConnectorCtx, settings: Record<string, any>): Promise<string> {
  const grant: any = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    fetchFn: ctx.fetch,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.client_id,
      client_secret: settings.client_secret,
      refresh_token: settings.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!grant?.access_token) throw new Error('Google OAuth: kein access_token erhalten');
  return grant.access_token;
}

function apiHeaders(settings: Record<string, any>, token: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'developer-token': settings.developer_token };
  if (settings.login_customer_id) headers['login-customer-id'] = digits(settings.login_customer_id);
  return headers;
}

async function search(ctx: ConnectorCtx, settings: Record<string, any>, token: string, query: string): Promise<any[]> {
  const version = settings.api_version || GOOGLE_DEFAULT_VERSION;
  const response: any = await fetchJson(
    `https://googleads.googleapis.com/${version}/customers/${digits(settings.customer_id)}/googleAds:searchStream`,
    { method: 'POST', headers: apiHeaders(settings, token), body: { query }, fetchFn: ctx.fetch, timeoutMs: 120_000 },
  );
  const batches = Array.isArray(response) ? response : [response];
  return batches.flatMap((batch: any) => batch?.results ?? []);
}

interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;
}

export const googleCosts: CostFetcher = async (ctx, settings, from, to) => {
  const token = await accessToken(ctx, settings);
  const where = `segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0`;
  const adRows = await search(
    ctx,
    settings,
    token,
    `SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name,
       metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
     FROM ad_group_ad WHERE ${where}`,
  );
  const campaignRows = await search(
    ctx,
    settings,
    token,
    `SELECT segments.date, customer.currency_code, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions,
       metrics.clicks, metrics.conversions, metrics.conversions_value
     FROM campaign WHERE ${where}`,
  );
  // jede Anzeige mit Impressionen gehört zu einer Kampagne mit Impressionen, die Kampagnenzeilen tragen die Währung des Kontos
  const currency: string | null = campaignRows[0]?.customer?.currencyCode ?? null;

  const rows: CostRow[] = [];
  const adTotals = new Map<string, Totals>();
  for (const adRow of adRows) {
    const date = adRow.segments?.date;
    const campaignId = String(adRow.campaign?.id ?? '');
    const row: CostRow = {
      date,
      campaignId,
      campaignName: adRow.campaign?.name ?? null,
      adsetId: String(adRow.adGroup?.id ?? ''),
      adsetName: adRow.adGroup?.name ?? null,
      adId: String(adRow.adGroupAd?.ad?.id ?? ''),
      adName: adRow.adGroupAd?.ad?.name ?? null,
      spend: toNumber(adRow.metrics?.costMicros) / 1e6,
      impressions: toNumber(adRow.metrics?.impressions),
      clicks: toNumber(adRow.metrics?.clicks),
      platformConversions: toNumber(adRow.metrics?.conversions),
      platformRevenue: toNumber(adRow.metrics?.conversionsValue),
      currency,
    };
    rows.push(row);
    const key = `${date}|${campaignId}`;
    const totals = adTotals.get(key) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 };
    totals.spend += row.spend;
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.conversions += row.platformConversions ?? 0;
    totals.value += row.platformRevenue ?? 0;
    adTotals.set(key, totals);
  }
  // Kampagnen ohne Anzeigenebene wie Performance Max als Restzeile
  for (const campaignRow of campaignRows) {
    const date = campaignRow.segments?.date;
    const campaignId = String(campaignRow.campaign?.id ?? '');
    const totals = adTotals.get(`${date}|${campaignId}`) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 };
    const metrics = campaignRow.metrics;
    const spend = toNumber(metrics?.costMicros) / 1e6 - totals.spend;
    const impressions = toNumber(metrics?.impressions) - totals.impressions;
    if (spend <= 0.005 && impressions <= 0) continue;
    rows.push({
      date,
      campaignId,
      campaignName: campaignRow.campaign?.name ?? null,
      adsetId: '',
      adsetName: null,
      adId: '',
      adName: null,
      spend: Math.max(0, spend),
      impressions: Math.max(0, impressions),
      clicks: Math.max(0, toNumber(metrics?.clicks) - totals.clicks),
      platformConversions: Math.max(0, toNumber(metrics?.conversions) - totals.conversions),
      platformRevenue: Math.max(0, toNumber(metrics?.conversionsValue) - totals.value),
      currency,
    });
  }
  return rows;
};

export const googleFeedback: FeedbackSender = async (ctx, settings, order) => {
  if (!settings.conversion_action_id) return skipped('Conversion Aktion fehlt');
  const click = lastClick(order, ['gclid', 'gbraid', 'wbraid'], 90);
  if (!click) return skipped('Kein Google Klick in den letzten 90 Tagen');
  const version = settings.api_version || GOOGLE_DEFAULT_VERSION;
  const customerId = digits(settings.customer_id);
  const conversion: Record<string, unknown> = {
    conversionAction: `customers/${customerId}/conversionActions/${digits(settings.conversion_action_id)}`,
    conversionDateTime: googleDateTime(order.createdAt, ctx.site.timezone),
    conversionValue: round2(order.value),
    currencyCode: order.currency,
    orderId: order.externalId,
    [click.clickIdType!]: click.clickId,
  };
  // Klick Conversions kennen nur adUserData (adPersonalization gilt für Kundenlisten), eine unbekannte Einwilligung bleibt weg
  if (order.consentMarketing !== null) conversion.consent = { adUserData: order.consentMarketing ? 'GRANTED' : 'DENIED' };
  const token = await accessToken(ctx, settings);
  const response: any = await fetchJson(`https://googleads.googleapis.com/${version}/customers/${customerId}:uploadClickConversions`, {
    method: 'POST',
    headers: apiHeaders(settings, token),
    body: { conversions: [conversion], partialFailure: true, validateOnly: !!settings.test_mode },
    fetchFn: ctx.fetch,
  });
  if (response?.partialFailureError) throw new Error(`Google Ads: ${JSON.stringify(response.partialFailureError).slice(0, 400)}`);
  return { status: 'sent', response: JSON.stringify(response).slice(0, 500) };
};
