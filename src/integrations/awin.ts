import { fetchJson } from '../lib/http.js';
import { round2, toNumber } from '../lib/normalize.js';
import { addDays, zonedDay, zonedStartOfDay } from '../lib/time.js';
import { PAID_CHANNELS } from '../tracking/classify.js';
import { chunkDays, lastClick, skipped, type CostFetcher, type CostRow, type FeedbackSender } from './types.js';

const DAY = 86_400_000;
const NOT_PAYABLE = new Set(['declined', 'deleted']);

const utcStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19);

function siteDay(transactionDate: unknown, timezone: string): string {
  const stamp = String(transactionDate ?? '');
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? stamp : `${stamp}Z`);
  return Number.isNaN(ms) ? '' : zonedDay(ms, timezone);
}

/** Provisionen je Publisher und Tag als Kosten des Kanals Awin */
export const awinCosts: CostFetcher = async (ctx, settings, from, to) => {
  const { timezone } = ctx.site;
  const byKey = new Map<string, CostRow>();
  // höchstens 31 Tage je Abfrage, 30 Kalendertage bleiben auch mit Zeitumstellung darunter
  for (const [start, end] of chunkDays(from, to, 30)) {
    // Awin kennt nur wenige Zeitzonen, daher in UTC abfragen und die Tage selbst umrechnen
    const params = new URLSearchParams({
      startDate: utcStamp(zonedStartOfDay(start, timezone).getTime()),
      endDate: utcStamp(zonedStartOfDay(addDays(end, 1), timezone).getTime() - 1000),
      timezone: 'UTC',
      dateType: 'transaction',
    });
    const transactions: any = await fetchJson(
      `https://api.awin.com/advertisers/${String(settings.advertiser_id).trim()}/transactions/?${params}`,
      { headers: { authorization: `Bearer ${settings.api_token}` }, fetchFn: ctx.fetch },
    );
    for (const transaction of Array.isArray(transactions) ? transactions : []) {
      if (NOT_PAYABLE.has(String(transaction.commissionStatus).toLowerCase())) continue;
      const date = siteDay(transaction.transactionDate, timezone);
      const publisher = String(transaction.publisherId ?? '');
      const key = `${date}|${publisher}`;
      const row =
        byKey.get(key) ??
        ({
          date,
          campaignId: publisher,
          campaignName: publisher ? `Publisher ${publisher}` : null,
          adsetId: '',
          adsetName: null,
          adId: '',
          adName: null,
          spend: 0,
          impressions: 0,
          clicks: 0,
          platformConversions: 0,
          platformRevenue: 0,
          currency: transaction.commissionAmount?.currency ?? null,
        } as CostRow);
      row.spend += toNumber(transaction.commissionAmount?.amount);
      row.platformConversions = (row.platformConversions ?? 0) + 1;
      row.platformRevenue = (row.platformRevenue ?? 0) + toNumber(transaction.saleAmount?.amount);
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].filter((row) => row.date);
};

/** Kanal aw, wenn Awin der letzte bezahlte Klick war, sonst other (Deduplizierung nach Last Paid Click) */
export const awinFeedback: FeedbackSender = async (ctx, settings, order) => {
  if (!settings.conversion_api_key) return skipped('Conversion API Key fehlt');
  const cookieDays = Number(settings.cookie_days) > 0 ? Number(settings.cookie_days) : 30;
  const awinClick = lastClick(order, ['awc'], cookieDays);
  if (!awinClick) return skipped('Kein Awin Klick im Cookie Zeitraum');
  const minTs = order.createdAt.getTime() - cookieDays * DAY;
  let lastPaid: string | null = null;
  for (let i = order.journey.length - 1; i >= 0; i--) {
    const touch = order.journey[i];
    if (touch.ts < minTs) break;
    if (PAID_CHANNELS.has(touch.channel)) {
      lastPaid = touch.channel;
      break;
    }
  }
  const channel = ctx.site.settings.awinDedup === 'always_aw' || lastPaid === 'awin' ? 'aw' : 'other';
  const amount = round2(Math.max(0, order.total - order.tax - order.shipping));
  const group = settings.commission_group || 'DEFAULT';
  const body = {
    orders: [
      {
        orderReference: encodeURIComponent(order.externalId).slice(0, 50),
        amount,
        channel,
        currency: order.currency,
        commissionGroups: [{ code: group, amount }],
        awc: awinClick.clickId,
        isTest: !!settings.test_mode,
        customerAcquisition: order.isNew === null ? undefined : order.isNew ? 'NEW' : 'RETURNING',
      },
    ],
  };
  const response = await fetchJson(`https://api.awin.com/s2s/advertiser/${String(settings.advertiser_id).trim()}/orders`, {
    method: 'POST',
    headers: { 'x-api-key': settings.conversion_api_key },
    body,
    fetchFn: ctx.fetch,
  });
  return { status: 'sent', detail: `Kanal ${channel}`, response: JSON.stringify(response ?? {}).slice(0, 500) };
};
