import type { SessionTouch } from '../attribution/engine.js';
import type { FetchFn } from '../lib/http.js';
import { addDays } from '../lib/time.js';
import type { MatchData, OrderItem } from '../orders/ingest.js';
import type { Site } from '../sites.js';

export interface CostRow {
  date: string;
  campaignId: string;
  campaignName: string | null;
  adsetId: string;
  adsetName: string | null;
  adId: string;
  adName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  platformConversions?: number | null;
  platformRevenue?: number | null;
  currency?: string | null;
}

export interface ConnectorCtx {
  fetch: FetchFn;
  site: Site;
}

export interface FeedbackOrder {
  externalId: string;
  orderNumber: string | null;
  createdAt: Date;
  currency: string;
  value: number;
  total: number;
  tax: number;
  shipping: number;
  items: OrderItem[];
  emailHash: string | null;
  phoneHash: string | null;
  /** gehashte stabile Kennung (Kundennummer oder Besucher ID) */
  externalIdHash: string | null;
  isNew: boolean | null;
  /** Marketing Einwilligung, null wenn unbekannt */
  consentMarketing: boolean | null;
  match: MatchData;
  /** alle Touchpoints vor dem Kauf, chronologisch */
  journey: SessionTouch[];
  landingUrl: string | null;
}

export interface FeedbackResult {
  status: 'sent' | 'skipped';
  detail?: string;
  response?: string;
}

export type CostFetcher = (ctx: ConnectorCtx, values: Record<string, any>, from: string, to: string) => Promise<CostRow[]>;
export type FeedbackSender = (ctx: ConnectorCtx, values: Record<string, any>, order: FeedbackOrder) => Promise<FeedbackResult>;

export const skipped = (detail: string): FeedbackResult => ({ status: 'skipped', detail });

const DAY = 86_400_000;

export function lastClick(order: FeedbackOrder, clickIdTypes: string[], windowDays: number): SessionTouch | null {
  const minTs = order.createdAt.getTime() - windowDays * DAY;
  for (let i = order.journey.length - 1; i >= 0; i--) {
    const touch = order.journey[i];
    if (touch.ts < minTs) break;
    if (touch.clickIdType && touch.clickId && clickIdTypes.includes(touch.clickIdType)) return touch;
  }
  return null;
}

export function chunkDays(from: string, to: string, maxDays: number): [string, string][] {
  const chunks: [string, string][] = [];
  for (let start = from; start <= to; start = addDays(start, maxDays)) {
    const end = addDays(start, maxDays - 1);
    chunks.push([start, end < to ? end : to]);
  }
  return chunks;
}
