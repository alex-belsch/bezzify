import type { Queryable } from '../db/index.js';
import { dayList, zonedDay } from '../lib/time.js';
import type { ModelId, Site } from '../sites.js';
import { loadSurveyTallies } from '../survey.js';
import { CHANNEL_LABELS, PAID_CHANNELS } from '../tracking/classify.js';
import {
  attribute,
  loadJourneyData,
  markovWeights,
  type AttributionResult,
  type CustomerGroup,
  type JourneyData,
  type RangeParams,
  type SessionTouch,
} from './engine.js';
import { distributeUnattributed, surveyCorrection, type AnswerCounts, type CreditExtra } from './extrapolation.js';
import { MODEL_LABELS, MODELS, allocate, prepareTouches } from './models.js';

const DAY = 86_400_000;

export interface ReportParams extends RangeParams {
  model: ModelId;
  ignoreDirect: boolean;
  extrapolate: boolean;
}

export interface Metrics {
  spend: number;
  impressions: number;
  clicks: number;
  sessions: number;
  orders: number;
  revenue: number;
  newOrders: number;
  platformConversions: number;
  platformRevenue: number;
}

export interface RowOut extends Metrics {
  key: string;
  label: string;
  roas: number | null;
  cpa: number | null;
  cvr: number | null;
  aov: number | null;
  cac: number | null;
  children?: RowOut[];
}

interface TreeNode {
  key: string;
  label: string | null;
  metrics: Metrics;
  children: Map<string, TreeNode>;
}

const emptyMetrics = (): Metrics => ({
  spend: 0,
  impressions: 0,
  clicks: 0,
  sessions: 0,
  orders: 0,
  revenue: 0,
  newOrders: 0,
  platformConversions: 0,
  platformRevenue: 0,
});

function childNode(parent: TreeNode, key: string): TreeNode {
  let node = parent.children.get(key);
  if (!node) parent.children.set(key, (node = { key, label: null, metrics: emptyMetrics(), children: new Map() }));
  return node;
}

function setLabel(node: TreeNode, label: string | null | undefined) {
  if (label && !node.label) node.label = label;
}

interface CostLine {
  channel: string;
  platform: string;
  campaign_id: string;
  campaign_name: string | null;
  adset_id: string;
  adset_name: string | null;
  ad_id: string;
  ad_name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  platform_conversions: number | null;
  platform_revenue: number | null;
}

interface ManualCost {
  id: string;
  channel: string;
  label: string;
  amount: number;
  date_from: string;
  date_to: string;
}

// gerechnet statt über dayList gezählt, das bei rund zehn Jahren abbricht
function dayCount(from: string, to: string): number {
  return from > to ? 0 : Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
}

const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

async function loadManualCosts(q: Queryable, site: Site, from: string, to: string): Promise<ManualCost[]> {
  return q.query<ManualCost>(
    `select id, channel, label, amount::float8 as amount, date_from::text as date_from, date_to::text as date_to
     from manual_costs where site_id = $1 and date_from <= $3::date and date_to >= $2::date`,
    [site.id, from, to],
  );
}

export async function loadCosts(q: Queryable, site: Site, from: string, to: string): Promise<CostLine[]> {
  const costs = await q.query<CostLine>(
    `select channel, platform, campaign_id, max(campaign_name) as campaign_name, adset_id, max(adset_name) as adset_name,
       ad_id, max(ad_name) as ad_name, sum(spend)::float8 as spend, sum(impressions)::float8 as impressions,
       sum(clicks)::float8 as clicks, sum(platform_conversions)::float8 as platform_conversions,
       sum(platform_revenue)::float8 as platform_revenue
     from costs where site_id = $1 and date >= $2::date and date <= $3::date
     group by channel, platform, campaign_id, adset_id, ad_id`,
    [site.id, from, to],
  );
  for (const manual of await loadManualCosts(q, site, from, to)) {
    const days = dayCount(later(from, manual.date_from), earlier(to, manual.date_to));
    costs.push({
      channel: manual.channel,
      platform: 'manual',
      campaign_id: `manual:${manual.id}`,
      campaign_name: manual.label,
      adset_id: '',
      adset_name: null,
      ad_id: '',
      ad_name: null,
      spend: (manual.amount * days) / Math.max(1, dayCount(manual.date_from, manual.date_to)),
      impressions: 0,
      clicks: 0,
      platform_conversions: null,
      platform_revenue: null,
    });
  }
  return costs;
}

export async function dailySpend(q: Queryable, site: Site, from: string, to: string): Promise<Map<string, number>> {
  const spendByDay = new Map<string, number>();
  const rows = await q.query<{ day: string; spend: number }>(
    `select date::text as day, sum(spend)::float8 as spend from costs
     where site_id = $1 and date >= $2::date and date <= $3::date group by date`,
    [site.id, from, to],
  );
  for (const row of rows) spendByDay.set(row.day, (spendByDay.get(row.day) ?? 0) + row.spend);
  for (const manual of await loadManualCosts(q, site, from, to)) {
    const perDay = manual.amount / Math.max(1, dayCount(manual.date_from, manual.date_to));
    for (const day of dayList(later(from, manual.date_from), earlier(to, manual.date_to))) {
      spendByDay.set(day, (spendByDay.get(day) ?? 0) + perDay);
    }
  }
  return spendByDay;
}

interface SessionGroup {
  channel: string;
  ext_campaign_id: string | null;
  campaign: string | null;
  ext_adset_id: string | null;
  ext_ad_id: string | null;
  sessions: number;
}

async function loadSessionCounts(q: Queryable, site: Site, journeyData: JourneyData): Promise<SessionGroup[]> {
  // feste Reihenfolge, sonst wechselt die Beschriftung bei mehreren utm_campaign Werten je Kampagne zwischen Abrufen
  return q.query<SessionGroup>(
    `select channel, ext_campaign_id, campaign, ext_adset_id, ext_ad_id, count(*)::int as sessions
     from sessions where site_id = $1 and started_at >= $2 and started_at < $3
     group by channel, ext_campaign_id, campaign, ext_adset_id, ext_ad_id
     order by campaign desc nulls last`,
    [site.id, new Date(journeyData.fromTs), new Date(journeyData.toTs)],
  );
}

// in JS statt mit lower() in SQL, das je nach Locale der Datenbank Umlaute nicht umwandelt
function campaignKeyOf(touch: Pick<SessionTouch, 'extCampaignId' | 'campaign'>): string {
  return touch.extCampaignId ?? (touch.campaign ? `name:${touch.campaign.toLowerCase()}` : '');
}

function ratios(metrics: Metrics): Pick<RowOut, 'roas' | 'cpa' | 'cvr' | 'aov' | 'cac'> {
  const { spend, orders, revenue, sessions, newOrders } = metrics;
  return {
    roas: spend > 0 ? revenue / spend : null,
    cpa: orders > 0 && spend > 0 ? spend / orders : null,
    cvr: sessions > 0 ? orders / sessions : null,
    aov: orders > 0 ? revenue / orders : null,
    cac: newOrders > 0 && spend > 0 ? spend / newOrders : null,
  };
}

/** Woher die hochgerechneten Käufe kommen und worauf die Verteilung beruht, für die Erklärung im Dashboard */
export interface ExtrapolationSummary {
  orders: number;
  revenue: number;
  byCustomer: Record<CustomerGroup, number>;
  pooled: CustomerGroup[];
  survey: {
    applied: boolean;
    tracked: number;
    untracked: number;
    deviation: number | null;
    answers: AnswerCounts[];
  };
}

const EMPTY_LABEL = ['', '(ohne Kampagne)', '(ohne Anzeigengruppe)', '(ohne Anzeige)'];

function toRow(node: TreeNode, depth: number, maxDepth: number): RowOut {
  const metrics = { ...node.metrics };
  let label = node.label;
  if (!label) {
    if (depth === 0) label = CHANNEL_LABELS[node.key] ?? node.key;
    else if (!node.key) label = EMPTY_LABEL[depth];
    else if (node.key.startsWith('name:')) label = node.key.slice(5);
    else label = `ID ${node.key}`;
  }
  const row: RowOut = { key: node.key, label, ...metrics, ...ratios(metrics) };
  if (depth < maxDepth && node.children.size) {
    row.children = [...node.children.values()]
      .map((child) => toRow(child, depth + 1, maxDepth))
      .sort((a, b) => b.spend - a.spend || b.revenue - a.revenue || b.sessions - a.sessions);
  }
  return row;
}

export interface BreakdownResult {
  rows: RowOut[];
  totals: RowOut;
  unattributed: AttributionResult['unattributed'];
  attribution: AttributionResult;
  journeyData: JourneyData;
  extrapolated: boolean;
  extrapolation: ExtrapolationSummary | null;
}

async function extrapolation(
  q: Queryable,
  site: Site,
  journeyData: JourneyData,
  attribution: AttributionResult,
): Promise<{ extras: CreditExtra[]; summary: ExtrapolationSummary } | null> {
  const { unattributed } = attribution;
  if (!unattributed.orders || !attribution.credits.length) return null;
  const tallies = await loadSurveyTallies(q, site, journeyData.fromTs, journeyData.toTs);
  const correction = surveyCorrection(site.settings.survey, tallies);
  const { extras, pooled } = distributeUnattributed(attribution, correction.factors);
  const { byCustomer } = unattributed;
  return {
    extras,
    summary: {
      orders: unattributed.orders,
      revenue: unattributed.revenue,
      byCustomer: { new: byCustomer.new.orders, returning: byCustomer.returning.orders, unknown: byCustomer.unknown.orders },
      pooled,
      survey: {
        applied: correction.factors.size > 0,
        tracked: correction.tracked,
        untracked: correction.untracked,
        deviation: correction.deviation,
        answers: correction.answers,
      },
    },
  };
}

/** Baum Kanal > Kampagne > Anzeigengruppe > Anzeige mit Kosten, Sessions und attribuierten Käufen */
export async function breakdown(
  q: Queryable,
  site: Site,
  params: ReportParams,
  opts: { channel?: string | null; maxDepth?: number; journeyData?: JourneyData } = {},
): Promise<BreakdownResult> {
  const journeyData = opts.journeyData ?? (await loadJourneyData(q, site, params));
  const weights = params.model === 'data_driven' ? await markovWeights(q, journeyData, params.ignoreDirect) : undefined;
  const attribution = attribute(journeyData, { model: params.model, ignoreDirect: params.ignoreDirect, channelWeights: weights });
  const costs = await loadCosts(q, site, params.from, params.to);
  const sessions = await loadSessionCounts(q, site, journeyData);

  // Kampagnennamen aus UTM auf IDs der Plattform abbilden, ein Name mehrerer Kampagnen bleibt unzugeordnet
  const idsByName = new Map<string, Set<string>>();
  for (const cost of costs) {
    if (!cost.campaign_id || !cost.campaign_name || cost.campaign_id.startsWith('manual:')) continue;
    const key = `${cost.channel}|name:${cost.campaign_name.toLowerCase()}`;
    idsByName.set(key, (idsByName.get(key) ?? new Set<string>()).add(cost.campaign_id));
  }
  const remap = (channel: string, campaignKey: string) => {
    const ids = campaignKey.startsWith('name:') ? idsByName.get(`${channel}|${campaignKey}`) : undefined;
    return ids?.size === 1 ? [...ids][0] : campaignKey;
  };

  const root: TreeNode = { key: 'root', label: null, metrics: emptyMetrics(), children: new Map() };
  const nodesFor = (channel: string, campaignKey: string, adsetKey: string, adKey: string) => {
    const channelNode = childNode(root, channel);
    const campaignNode = childNode(channelNode, remap(channel, campaignKey));
    const adsetNode = childNode(campaignNode, adsetKey);
    return [channelNode, campaignNode, adsetNode, childNode(adsetNode, adKey)];
  };
  const included = (channel: string) => !opts.channel || opts.channel === channel;

  for (const cost of costs) {
    if (!included(cost.channel)) continue;
    const nodes = nodesFor(cost.channel, cost.campaign_id, cost.adset_id, cost.ad_id);
    setLabel(nodes[1], cost.campaign_name);
    setLabel(nodes[2], cost.adset_name);
    setLabel(nodes[3], cost.ad_name);
    for (const node of nodes) {
      node.metrics.spend += cost.spend;
      node.metrics.impressions += cost.impressions;
      node.metrics.clicks += cost.clicks;
      node.metrics.platformConversions += cost.platform_conversions ?? 0;
      node.metrics.platformRevenue += cost.platform_revenue ?? 0;
    }
  }
  for (const group of sessions) {
    if (!included(group.channel)) continue;
    const campaignKey = campaignKeyOf({ extCampaignId: group.ext_campaign_id, campaign: group.campaign });
    const nodes = nodesFor(group.channel, campaignKey, group.ext_adset_id ?? '', group.ext_ad_id ?? '');
    // Namen der Plattform aus den Kosten haben Vorrang, sonst utm_campaign
    if (campaignKey) setLabel(nodes[1], group.campaign);
    for (const node of nodes) node.metrics.sessions += group.sessions;
  }
  // verteilt wird über alle Kanäle, auch bei Filter auf einen Kanal, sonst bekäme der gefilterte Kanal den ganzen Rest
  const extrapolated = params.extrapolate ? await extrapolation(q, site, journeyData, attribution) : null;
  attribution.credits.forEach((credit, i) => {
    const { touch } = credit;
    if (!included(touch.channel)) return;
    const campaignKey = campaignKeyOf(touch);
    const nodes = nodesFor(touch.channel, campaignKey, touch.extAdsetId ?? '', touch.extAdId ?? '');
    if (campaignKey) setLabel(nodes[1], touch.campaign);
    if (touch.extAdId) setLabel(nodes[3], touch.content);
    const extra = extrapolated?.extras[i];
    for (const node of nodes) {
      node.metrics.orders += credit.share + (extra?.orders ?? 0);
      node.metrics.revenue += credit.share * credit.revenue + (extra?.revenue ?? 0);
      node.metrics.newOrders += (credit.isNew ? credit.share : 0) + (extra?.newOrders ?? 0);
    }
  });

  const maxDepth = opts.maxDepth ?? 3;
  const rows = [...root.children.values()]
    .map((node) => toRow(node, 0, maxDepth))
    .sort((a, b) => b.revenue - a.revenue || b.spend - a.spend);
  const total = emptyMetrics();
  for (const row of rows) for (const key of Object.keys(total) as (keyof Metrics)[]) total[key] += row[key];
  const totals: RowOut = { key: 'total', label: 'Gesamt', ...total, ...ratios(total) };
  return {
    rows,
    totals,
    unattributed: attribution.unattributed,
    attribution,
    journeyData,
    extrapolated: !!extrapolated,
    extrapolation: extrapolated?.summary ?? null,
  };
}

export async function overview(q: Queryable, site: Site, params: ReportParams) {
  const journeyData = await loadJourneyData(q, site, params);
  const byChannel = await breakdown(q, site, params, { maxDepth: 0, journeyData });
  const spendByDay = await dailySpend(q, site, params.from, params.to);

  const days = dayList(params.from, params.to);
  const series = new Map(days.map((day) => [day, { date: day, revenue: 0, orders: 0, spend: spendByDay.get(day) ?? 0 }]));
  let revenue = 0;
  let refunded = 0;
  let newOrders = 0;
  let tracked = 0;
  for (const order of journeyData.orders) {
    revenue += order.revenue;
    refunded += order.refunded;
    if (order.isNew) newOrders++;
    if ((journeyData.touches.get(order.id) ?? []).some((touch) => !touch.fromShop)) tracked++;
    const point = series.get(zonedDay(order.createdAt, site.timezone));
    if (point) {
      point.revenue += order.revenue;
      point.orders++;
    }
  }
  const orders = journeyData.orders.length;
  const spend = [...spendByDay.values()].reduce((a, b) => a + b, 0);
  const paidRows = byChannel.rows.filter((row) => PAID_CHANNELS.has(row.key));
  const paidRevenue = paidRows.reduce((sum, row) => sum + row.revenue, 0);
  const paidSpend = paidRows.reduce((sum, row) => sum + row.spend, 0);

  const channels = [...byChannel.rows];
  const { unattributed } = byChannel;
  // ohne einen einzigen zugeordneten Kauf gibt es nichts, worauf sich hochrechnen ließe
  if (!byChannel.extrapolated && unattributed.orders > 0) {
    const metrics = { ...emptyMetrics(), orders: unattributed.orders, revenue: unattributed.revenue, newOrders: unattributed.newOrders };
    channels.push({ key: 'unattributed', label: CHANNEL_LABELS.unattributed, ...metrics, ...ratios(metrics) });
  }

  return {
    range: { from: params.from, to: params.to },
    currency: site.currency,
    model: params.model,
    windowDays: params.windowDays,
    basis: params.basis,
    extrapolated: byChannel.extrapolated,
    extrapolation: byChannel.extrapolation,
    kpis: {
      revenue,
      orders,
      aov: orders ? revenue / orders : null,
      spend,
      mer: spend > 0 ? revenue / spend : null,
      paidRevenue,
      paidSpend,
      paidRoas: paidSpend > 0 ? paidRevenue / paidSpend : null,
      newOrders,
      newShare: orders ? newOrders / orders : null,
      cac: newOrders > 0 && spend > 0 ? spend / newOrders : null,
      refunded,
      trackedOrders: tracked,
      coverage: orders ? tracked / orders : null,
      unattributedOrders: unattributed.orders,
      unattributedRevenue: unattributed.revenue,
      sessions: byChannel.totals.sessions,
    },
    timeseries: [...series.values()],
    channels,
    platforms: byChannel.rows
      .filter((row) => row.platformConversions > 0 || row.platformRevenue > 0)
      .map((row) => ({
        channel: row.key,
        label: row.label,
        platformConversions: row.platformConversions,
        platformRevenue: row.platformRevenue,
        orders: row.orders,
        revenue: row.revenue,
      })),
  };
}

export async function modelComparison(q: Queryable, site: Site, params: ReportParams) {
  const journeyData = await loadJourneyData(q, site, params);
  const weights = await markovWeights(q, journeyData, params.ignoreDirect);
  const rows = new Map<string, { channel: string; label: string; values: Record<string, { orders: number; revenue: number }> }>();
  for (const model of MODELS) {
    const { credits } = attribute(journeyData, { model, ignoreDirect: params.ignoreDirect, channelWeights: weights });
    for (const credit of credits) {
      const { channel } = credit.touch;
      let row = rows.get(channel);
      if (!row) rows.set(channel, (row = { channel, label: CHANNEL_LABELS[channel] ?? channel, values: {} }));
      const sums = (row.values[model] ??= { orders: 0, revenue: 0 });
      sums.orders += credit.share;
      sums.revenue += credit.share * credit.revenue;
    }
  }
  const list = [...rows.values()];
  for (const row of list) for (const model of MODELS) row.values[model] ??= { orders: 0, revenue: 0 };
  list.sort((a, b) => (b.values[params.model]?.revenue ?? 0) - (a.values[params.model]?.revenue ?? 0));
  return {
    models: MODELS.map((id) => ({ id, label: MODEL_LABELS[id] })),
    rows: list,
    markov: [...weights.entries()].map(([channel, removalEffect]) => ({ channel, label: CHANNEL_LABELS[channel] ?? channel, removalEffect })),
  };
}

export async function journeys(q: Queryable, site: Site, params: ReportParams, opts: { limit: number; channel?: string | null }) {
  const journeyData = await loadJourneyData(q, site, { ...params, basis: 'conversion' });
  const weights = params.model === 'data_driven' ? await markovWeights(q, journeyData, params.ignoreDirect) : undefined;
  const ignoreDirect = params.model === 'last_non_direct' ? true : params.ignoreDirect;
  const rows = [];
  for (const order of [...journeyData.orders].sort((a, b) => b.createdAt - a.createdAt)) {
    const touches = prepareTouches(journeyData.touches.get(order.id) ?? [], order.createdAt, params.windowDays, false);
    if (opts.channel && !touches.some((touch) => touch.channel === opts.channel)) continue;
    const credited = prepareTouches(touches, order.createdAt, params.windowDays, ignoreDirect);
    const shares = allocate(params.model, credited, {
      halfLifeDays: site.settings.timeDecayHalfLifeDays,
      channelWeights: weights,
    });
    const shareById = new Map(credited.map((touch, i) => [touch.id, shares[i]]));
    rows.push({
      id: order.id,
      externalId: order.externalId,
      orderNumber: order.orderNumber,
      createdAt: new Date(order.createdAt).toISOString(),
      revenue: order.revenue,
      refunded: order.refunded > 0,
      isNew: order.isNew,
      touchCount: touches.length,
      daysToConvert: touches.length ? (order.createdAt - touches[0].ts) / DAY : null,
      touches: touches.map((touch) => ({
        ts: new Date(touch.ts).toISOString(),
        channel: touch.channel,
        label: CHANNEL_LABELS[touch.channel] ?? touch.channel,
        source: touch.source,
        campaign: touch.campaign,
        isPaid: touch.isPaid,
        fromShop: !!touch.fromShop,
        device: touch.device,
        share: shareById.get(touch.id) ?? 0,
      })),
    });
    if (rows.length >= opts.limit) break;
  }
  return { orders: rows, total: journeyData.orders.length };
}
