import type { Queryable } from '../db/index.js';
import { addDays, zonedStartOfDay } from '../lib/time.js';
import type { ModelId, Site } from '../sites.js';
import { classify } from '../tracking/classify.js';
import { markov, type MarkovPath } from './markov.js';
import { allocate, prepareTouches } from './models.js';

const DAY = 86_400_000;
/** Obergrenze für "unbegrenzt", damit Abfragen beherrschbar bleiben */
const UNLIMITED_DAYS = 730;
const lookbackMs = (windowDays: number | null) => (windowDays ?? UNLIMITED_DAYS) * DAY;
/** Sessions bis eine Minute nach dem Kauf gehören noch dazu, Zeitstempel stammen teils von der Uhr im Browser */
const CLOCK_SKEW_MS = 60_000;

export interface SessionTouch {
  id: string;
  ts: number;
  channel: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  isPaid: boolean;
  clickIdType: string | null;
  clickId: string | null;
  extCampaignId: string | null;
  extAdsetId: string | null;
  extAdId: string | null;
  visitorId: string | null;
  landingUrl: string | null;
  device: string | null;
  fromShop?: boolean;
}

export interface OrderRow {
  id: string;
  externalId: string;
  orderNumber: string | null;
  createdAt: number;
  revenue: number;
  grossTotal: number;
  refunded: number;
  currency: string;
  isNew: boolean | null;
  visitorId: string | null;
  emailHash: string | null;
  customerKey: string | null;
  status: string;
  landingUrl: string | null;
  referrer: string | null;
}

export interface RangeParams {
  from: string;
  to: string;
  windowDays: number | null;
  basis: 'conversion' | 'touch';
}

export interface JourneyData {
  site: Site;
  range: RangeParams;
  fromTs: number;
  toTs: number;
  orders: OrderRow[];
  /** spätere Bestellungen, nur für das Attributionsdatum Touchpoint */
  extraOrders: OrderRow[];
  touches: Map<string, SessionTouch[]>;
}

/** Neu oder wiederkehrend weiß der Shop auch ohne Einwilligung, die Hochrechnung trennt danach */
export type CustomerGroup = 'new' | 'returning' | 'unknown';
export const CUSTOMER_GROUPS: CustomerGroup[] = ['new', 'returning', 'unknown'];

export function customerGroup(isNew: boolean | null): CustomerGroup {
  return isNew === null ? 'unknown' : isNew ? 'new' : 'returning';
}

export interface Credit {
  orderId: string;
  orderTs: number;
  touchTs: number;
  share: number;
  revenue: number;
  isNew: boolean;
  customer: CustomerGroup;
  /** erster Kanal der Journey, auch Direkt; danach fragt die Umfrage nach dem Kauf */
  firstChannel: string;
  touch: SessionTouch;
}

export interface OrderTotals {
  orders: number;
  revenue: number;
  newOrders: number;
}

export interface AttributionResult {
  credits: Credit[];
  unattributed: OrderTotals & { byCustomer: Record<CustomerGroup, OrderTotals> };
  attributedOrders: number;
}

export function revenueOf(amounts: { total: number; tax: number; shipping: number; refunded: number }, site: Site): number {
  const { total, tax, shipping, refunded } = amounts;
  const base = site.settings.revenueBasis === 'net' ? Math.max(0, total - tax - shipping) : total;
  if (!site.settings.subtractRefunds || refunded <= 0 || total <= 0) return base;
  return Math.max(0, base * (1 - Math.min(1, refunded / total)));
}

export function rangeToTs(site: Site, from: string, to: string): { fromTs: number; toTs: number } {
  return {
    fromTs: zonedStartOfDay(from, site.timezone).getTime(),
    toTs: zonedStartOfDay(addDays(to, 1), site.timezone).getTime(),
  };
}

function mapOrder(row: any, site: Site): OrderRow {
  const total = Number(row.total);
  const tax = Number(row.tax);
  const shipping = Number(row.shipping);
  const refunded = Number(row.refunded);
  return {
    id: row.id,
    externalId: row.external_id,
    orderNumber: row.order_number,
    createdAt: new Date(row.created_at).getTime(),
    revenue: revenueOf({ total, tax, shipping, refunded }, site),
    grossTotal: total,
    refunded,
    currency: row.currency,
    isNew: row.is_new_customer,
    visitorId: row.visitor_id,
    emailHash: row.email_sha256,
    customerKey: row.customer_key,
    status: row.status,
    landingUrl: row.landing_url,
    referrer: row.referrer,
  };
}

function mapSession(row: any): SessionTouch {
  return {
    id: row.id,
    ts: new Date(row.started_at).getTime(),
    channel: row.channel,
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    content: row.content,
    isPaid: row.is_paid,
    clickIdType: row.click_id_type,
    clickId: row.click_id,
    extCampaignId: row.ext_campaign_id,
    extAdsetId: row.ext_adset_id,
    extAdId: row.ext_ad_id,
    visitorId: row.visitor_id,
    landingUrl: row.landing_url,
    device: row.device,
  };
}

const ORDER_COLS = `id, external_id, order_number, created_at, total, tax, shipping, refunded, currency, is_new_customer,
  visitor_id, email_sha256, customer_key, status, landing_url, referrer`;

export async function loadOrders(q: Queryable, site: Site, fromTs: number, toTs: number, includeTest = false): Promise<OrderRow[]> {
  // Meldet der Shop selbst Bestellungen, zählen reine Pixel Bestellungen nicht, mit dem öffentlichen Site Key ließen sie sich fälschen
  const rows = await q.query(
    `select ${ORDER_COLS} from orders
     where site_id = $1 and created_at >= $2 and created_at < $3 and status <> 'cancelled' ${includeTest ? '' : 'and not is_test'}
       and (source <> 'pixel' or not exists (select 1 from orders s where s.site_id = $1 and s.source <> 'pixel'))
     order by created_at`,
    [site.id, new Date(fromTs), new Date(toTs)],
  );
  return rows.map((row) => mapOrder(row, site));
}

export async function loadOrderById(q: Queryable, site: Site, orderId: string): Promise<OrderRow | null> {
  const rows = await q.query(`select ${ORDER_COLS} from orders where site_id = $1 and id = $2`, [site.id, orderId]);
  return rows[0] ? mapOrder(rows[0], site) : null;
}

/** Besucher je Bestellung, direkt und geräteübergreifend über gehashte Mailadresse oder Kundennummer */
async function visitorsForOrders(
  q: Queryable,
  site: Site,
  orders: OrderRow[],
  verifiedOnly: boolean,
): Promise<Map<string, Set<string>>> {
  const onlyVerified = verifiedOnly ? ' and verified' : '';
  const visitorsByOrder = new Map<string, Set<string>>();
  const identityKeys = new Set<string>();
  const directVisitors = new Set<string>();
  for (const order of orders) {
    visitorsByOrder.set(order.id, new Set(order.visitorId ? [order.visitorId] : []));
    if (order.emailHash) identityKeys.add(order.emailHash);
    if (order.customerKey) identityKeys.add(order.customerKey);
    if (order.visitorId) directVisitors.add(order.visitorId);
  }
  // Identitäten der kaufenden Besucher, etwa nach einem früheren Login auf einem anderen Gerät
  const identitiesByVisitor = new Map<string, string[]>();
  if (directVisitors.size) {
    const rows = await q.query<{ visitor_id: string; value: string }>(
      `select visitor_id, value from identities where site_id = $1 and visitor_id = any($2)${onlyVerified}`,
      [site.id, [...directVisitors]],
    );
    for (const identity of rows) {
      identityKeys.add(identity.value);
      const list = identitiesByVisitor.get(identity.visitor_id) ?? [];
      list.push(identity.value);
      identitiesByVisitor.set(identity.visitor_id, list);
    }
  }
  if (!identityKeys.size) return visitorsByOrder;
  const rows = await q.query<{ visitor_id: string; value: string }>(
    `select visitor_id, value from identities where site_id = $1 and value = any($2)${onlyVerified}`,
    [site.id, [...identityKeys]],
  );
  const visitorsByKey = new Map<string, Set<string>>();
  for (const identity of rows) {
    const visitors = visitorsByKey.get(identity.value) ?? new Set();
    visitors.add(identity.visitor_id);
    visitorsByKey.set(identity.value, visitors);
  }
  for (const order of orders) {
    const visitors = visitorsByOrder.get(order.id)!;
    const keys = [order.emailHash, order.customerKey, ...(order.visitorId ? (identitiesByVisitor.get(order.visitorId) ?? []) : [])];
    for (const key of keys) if (key) for (const visitorId of visitorsByKey.get(key) ?? []) visitors.add(visitorId);
  }
  return visitorsByOrder;
}

const SESSION_COLS = `id, visitor_id, started_at, channel, source, medium, campaign, content, is_paid, click_id_type, click_id,
  ext_campaign_id, ext_adset_id, ext_ad_id, landing_url, device`;

export async function attachJourneys(
  q: Queryable,
  site: Site,
  orders: OrderRow[],
  windowDays: number | null,
  // Für die Rückspielung nur Verknüpfungen aus Shop Bestellungen, sonst ließen sich über eine bekannte Mailadresse fremde Klicks unterschieben
  { verifiedIdentitiesOnly = false }: { verifiedIdentitiesOnly?: boolean } = {},
): Promise<Map<string, SessionTouch[]>> {
  const journeys = new Map<string, SessionTouch[]>();
  if (!orders.length) return journeys;
  const visitorsByOrder = await visitorsForOrders(q, site, orders, verifiedIdentitiesOnly);
  const visitorIds = new Set<string>();
  for (const visitors of visitorsByOrder.values()) for (const visitorId of visitors) visitorIds.add(visitorId);
  // Schleife statt Math.min(...), der Spread wirft ab rund 125.000 Bestellungen einen RangeError
  let earliest = Infinity;
  let latest = -Infinity;
  for (const order of orders) {
    if (order.createdAt < earliest) earliest = order.createdAt;
    if (order.createdAt > latest) latest = order.createdAt;
  }
  const sessionsByVisitor = new Map<string, SessionTouch[]>();
  if (visitorIds.size) {
    const rows = await q.query(
      `select ${SESSION_COLS} from sessions
       where site_id = $1 and visitor_id = any($2) and started_at >= $3 and started_at <= $4`,
      [site.id, [...visitorIds], new Date(earliest - lookbackMs(windowDays)), new Date(latest + CLOCK_SKEW_MS)],
    );
    for (const row of rows) {
      const session = mapSession(row);
      const list = sessionsByVisitor.get(session.visitorId!) ?? [];
      list.push(session);
      sessionsByVisitor.set(session.visitorId!, list);
    }
  }
  for (const order of orders) {
    const seen = new Set<string>();
    const journey: SessionTouch[] = [];
    for (const visitorId of visitorsByOrder.get(order.id) ?? []) {
      for (const session of sessionsByVisitor.get(visitorId) ?? []) {
        if (seen.has(session.id) || session.ts > order.createdAt + CLOCK_SKEW_MS) continue;
        seen.add(session.id);
        journey.push(session);
      }
    }
    journey.sort((a, b) => a.ts - b.ts);
    if (!journey.length && (order.landingUrl || order.referrer)) {
      const touch = classify(order.landingUrl, order.referrer, {
        siteHosts: site.domains,
        clickIdWithoutParams: site.settings.clickIdWithoutParams,
      });
      if (touch.channel !== 'internal') {
        journey.push({
          id: `shop:${order.id}`,
          ts: order.createdAt - 60_000,
          channel: touch.channel,
          source: touch.source,
          medium: touch.medium,
          campaign: touch.campaign,
          content: touch.content,
          isPaid: touch.isPaid,
          clickIdType: touch.clickIdType,
          clickId: touch.clickId,
          extCampaignId: touch.extCampaignId,
          extAdsetId: touch.extAdsetId,
          extAdId: touch.extAdId,
          visitorId: null,
          landingUrl: order.landingUrl,
          device: null,
          fromShop: true,
        });
      }
    }
    journeys.set(order.id, journey);
  }
  return journeys;
}

export async function loadJourneyData(q: Queryable, site: Site, range: RangeParams): Promise<JourneyData> {
  const { fromTs, toTs } = rangeToTs(site, range.from, range.to);
  const orders = await loadOrders(q, site, fromTs, toTs);
  let extraOrders: OrderRow[] = [];
  if (range.basis === 'touch') {
    // Käufe nach dem Zeitraum können Touchpoints im Zeitraum Anteile geben
    const extraUntil = Math.min(Date.now() + DAY, toTs + lookbackMs(range.windowDays));
    extraOrders = await loadOrders(q, site, toTs, extraUntil);
  }
  const touches = await attachJourneys(q, site, [...orders, ...extraOrders], range.windowDays);
  return { site, range, fromTs, toTs, orders, extraOrders, touches };
}

/** Removal Effects je Kanal aus den Journeys der Käufe und den Pfaden der Besucher ohne Kauf im Zeitraum */
export async function markovWeights(q: Queryable, journeyData: JourneyData, ignoreDirect: boolean): Promise<Map<string, number>> {
  const { site, range, fromTs, toTs } = journeyData;
  const paths = new Map<string, MarkovPath>();
  const addPath = (channels: string[], converted: boolean) => {
    if (!channels.length) return;
    const key = (converted ? '1' : '0') + channels.join('>');
    const existing = paths.get(key);
    if (existing) existing.count = (existing.count ?? 1) + 1;
    else paths.set(key, { channels, converted, count: 1 });
  };
  const convertingVisitors = new Set<string>();
  for (const order of [...journeyData.orders, ...journeyData.extraOrders]) {
    const touches = prepareTouches(journeyData.touches.get(order.id) ?? [], order.createdAt, range.windowDays, ignoreDirect);
    for (const touch of touches) if (touch.visitorId) convertingVisitors.add(touch.visitorId);
    addPath(
      touches.map((touch) => touch.channel),
      true,
    );
  }
  // gleicher Rückblick wie für die Journeys der Käufe, sonst wären die Pfade ohne Kauf systematisch kürzer
  const rows = await q.query<{ visitor_id: string; channel: string }>(
    `select visitor_id, channel from sessions
     where site_id = $1 and visitor_id is not null and started_at >= $2 and started_at < $3
     order by visitor_id, started_at
     limit 300000`,
    [site.id, new Date(fromTs - lookbackMs(range.windowDays)), new Date(toTs)],
  );
  let visitorId: string | null = null;
  let channels: string[] = [];
  const flush = () => {
    if (!visitorId || convertingVisitors.has(visitorId)) return;
    const withoutDirect = channels.filter((channel) => channel !== 'direct');
    addPath(ignoreDirect && withoutDirect.length ? withoutDirect : channels, false);
  };
  for (const session of rows) {
    if (session.visitor_id !== visitorId) {
      flush();
      visitorId = session.visitor_id;
      channels = [];
    }
    channels.push(session.channel);
  }
  flush();
  return markov([...paths.values()]).removalEffects;
}

export interface AttributeOptions {
  model: ModelId;
  ignoreDirect: boolean;
  channelWeights?: Map<string, number>;
}

export function attribute(journeyData: JourneyData, opts: AttributeOptions): AttributionResult {
  const { site, range } = journeyData;
  const ignoreDirect = opts.model === 'last_non_direct' ? true : opts.ignoreDirect;
  const credits: Credit[] = [];
  const emptyTotals = (): OrderTotals => ({ orders: 0, revenue: 0, newOrders: 0 });
  const unattributed = { ...emptyTotals(), byCustomer: { new: emptyTotals(), returning: emptyTotals(), unknown: emptyTotals() } };
  let attributedOrders = 0;
  const inRange = (ts: number) => ts >= journeyData.fromTs && ts < journeyData.toTs;
  const orders = range.basis === 'touch' ? [...journeyData.orders, ...journeyData.extraOrders] : journeyData.orders;

  for (const order of orders) {
    const journey = journeyData.touches.get(order.id) ?? [];
    const touches = prepareTouches(journey, order.createdAt, range.windowDays, ignoreDirect);
    if (!touches.length) {
      if (inRange(order.createdAt)) {
        for (const totals of [unattributed, unattributed.byCustomer[customerGroup(order.isNew)]]) {
          totals.orders++;
          totals.revenue += order.revenue;
          if (order.isNew) totals.newOrders++;
        }
      }
      continue;
    }
    const shares = allocate(opts.model, touches, {
      halfLifeDays: site.settings.timeDecayHalfLifeDays,
      channelWeights: opts.channelWeights,
    });
    const firstChannel = ignoreDirect ? prepareTouches(journey, order.createdAt, range.windowDays, false)[0].channel : touches[0].channel;
    let counted = false;
    touches.forEach((touch, i) => {
      const share = shares[i];
      if (!share) return;
      if (!inRange(range.basis === 'touch' ? touch.ts : order.createdAt)) return;
      counted = true;
      credits.push({
        orderId: order.id,
        orderTs: order.createdAt,
        touchTs: touch.ts,
        share,
        revenue: order.revenue,
        isNew: !!order.isNew,
        customer: customerGroup(order.isNew),
        firstChannel,
        touch,
      });
    });
    if (counted) attributedOrders++;
  }
  return { credits, unattributed, attributedOrders };
}
