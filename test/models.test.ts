import { describe, expect, it } from 'vitest';
import { loadJourneyData, markovWeights, type JourneyData, type OrderRow, type SessionTouch } from '../src/attribution/engine.js';
import { markov } from '../src/attribution/markov.js';
import { MODELS, allocate, prepareTouches } from '../src/attribution/models.js';
import { breakdown, dailySpend, loadCosts, type ReportParams } from '../src/attribution/report.js';
import { defaultSettings, type Site } from '../src/sites.js';

const DAY = 86_400_000;
const conv = 100 * DAY;
const touchAt = (daysBefore: number, channel: string) => ({ ts: conv - daysBefore * DAY, channel });
const sum = (shares: number[]) => shares.reduce((total, share) => total + share, 0);

describe('prepareTouches', () => {
  it('filtert Fenster und Direktzugriffe', () => {
    const touches = [touchAt(40, 'meta'), touchAt(10, 'google_ads'), touchAt(1, 'direct'), touchAt(-1, 'meta')];
    expect(prepareTouches(touches, conv, 30, true).map((t) => t.channel)).toEqual(['google_ads']);
    expect(prepareTouches(touches, conv, 30, false).map((t) => t.channel)).toEqual(['google_ads', 'direct']);
    expect(prepareTouches(touches, conv, null, true).map((t) => t.channel)).toEqual(['meta', 'google_ads']);
  });

  it('behält Direkt, wenn es der einzige Touchpoint ist', () => {
    expect(prepareTouches([touchAt(1, 'direct')], conv, 30, true)).toHaveLength(1);
  });
});

describe('allocate', () => {
  const path = [touchAt(9, 'meta'), touchAt(5, 'tiktok'), touchAt(3, 'klaviyo'), touchAt(1, 'google_ads')];

  it('verteilt je Modell korrekt und summiert auf 1', () => {
    expect(allocate('first_click', path)).toEqual([1, 0, 0, 0]);
    expect(allocate('last_click', path)).toEqual([0, 0, 0, 1]);
    expect(allocate('linear', path)).toEqual([0.25, 0.25, 0.25, 0.25]);
    const positions = allocate('position_based', path);
    expect(positions[0]).toBeCloseTo(0.4);
    expect(positions[1]).toBeCloseTo(0.1);
    expect(positions[3]).toBeCloseTo(0.4);
    const decay = allocate('time_decay', path, { halfLifeDays: 7 });
    expect(sum(decay)).toBeCloseTo(1);
    expect(decay[3]).toBeGreaterThan(decay[0]);
    expect(allocate('position_based', path.slice(0, 2))).toEqual([0.5, 0.5]);
  });

  it('verteilt in Randfällen in jedem Modell genau einen Kauf', () => {
    const weights = new Map([
      ['meta', 0.5],
      ['direct', 0.2],
    ]);
    const journeys = [
      prepareTouches([touchAt(3, 'meta')], conv, 30, true),
      prepareTouches([touchAt(2, 'direct'), touchAt(1, 'direct')], conv, 30, true),
      prepareTouches([touchAt(2, 'meta'), touchAt(0, 'google_ads')], conv, 0, true),
      [touchAt(1, 'meta'), touchAt(1, 'tiktok'), touchAt(1, 'google_ads')],
      [touchAt(4, 'meta'), touchAt(1, 'tiktok')],
      // so alt, dass 0,5 hoch Alter durch Halbwertszeit für jeden Touchpoint auf 0 unterläuft
      [touchAt(700, 'meta'), touchAt(650, 'tiktok')],
    ];
    for (const touches of journeys) {
      expect(touches.length).toBeGreaterThan(0);
      for (const model of MODELS) {
        const shares = allocate(model, touches, { halfLifeDays: 0.5, channelWeights: weights });
        expect(shares).toHaveLength(touches.length);
        expect(shares.every((share) => Number.isFinite(share) && share >= 0)).toBe(true);
        expect(sum(shares)).toBeCloseTo(1, 12);
      }
    }
    expect(allocate('time_decay', [touchAt(1, 'meta'), touchAt(1, 'tiktok')])).toEqual([0.5, 0.5]);
  });

  it('rechnet den Zeitverfall bei ungültiger Halbwertszeit mit 7 Tagen', () => {
    for (const halfLifeDays of [0, -3, Number.NaN]) {
      expect(allocate('time_decay', path, { halfLifeDays })).toEqual(allocate('time_decay', path, { halfLifeDays: 7 }));
    }
  });

  it('nutzt Removal Effects im datengetriebenen Modell', () => {
    const weights = new Map([
      ['meta', 0.6],
      ['tiktok', 0.1],
      ['klaviyo', 0.2],
      ['google_ads', 0.1],
    ]);
    const shares = allocate('data_driven', path, { channelWeights: weights });
    expect(sum(shares)).toBeCloseTo(1);
    expect(shares[0]).toBeCloseTo(0.6);
    // gleicher Kanal zweimal, der Anteil wird geteilt
    const twice = allocate('data_driven', [touchAt(5, 'meta'), touchAt(2, 'meta'), touchAt(1, 'google_ads')], { channelWeights: weights });
    expect(twice[0]).toBeCloseTo(twice[1]);
    expect(sum(twice)).toBeCloseTo(1);
  });
});

describe('markov', () => {
  it('liefert hohen Removal Effect für einen Kanal, ohne den nichts konvertiert', () => {
    const chain = markov([
      { channels: ['meta', 'google_ads'], converted: true, count: 30 },
      { channels: ['meta'], converted: false, count: 70 },
      { channels: ['tiktok'], converted: false, count: 50 },
      { channels: ['tiktok', 'google_ads'], converted: true, count: 5 },
    ]);
    expect(chain.conversionProbability).toBeGreaterThan(0);
    // Google steht vor jeder Conversion, ohne Google sinkt die Wahrscheinlichkeit auf 0
    expect(chain.removalEffects.get('google_ads')).toBeCloseTo(1);
    expect(chain.removalEffects.get('meta')!).toBeGreaterThan(chain.removalEffects.get('tiktok')!);
    expect(sum([...chain.shares.values()])).toBeCloseTo(1);
  });

  it('kommt ohne Conversions mit leeren Ergebnissen aus', () => {
    const chain = markov([{ channels: ['meta'], converted: false }]);
    expect(chain.conversionProbability).toBe(0);
    expect(chain.removalEffects.size).toBe(0);
  });

  it('rechnet auch lange Pfade mit Wechseln zwischen zwei Kanälen genau', () => {
    const alternating = (length: number) => Array.from({ length }, (_, i) => (i % 2 ? 'google_ads' : 'meta'));
    // analytisch genau 0,5, die Kette verlässt den Wechsel je Schritt nur mit rund 1/2000
    const chain = markov([
      { channels: alternating(2000), converted: true },
      { channels: alternating(1999), converted: false },
    ]);
    expect(chain.conversionProbability).toBeCloseTo(0.5, 9);
    expect(chain.removalEffects.get('meta')).toBeCloseTo(1);
  });
});

const site: Site = {
  id: 'site_1',
  workspaceId: 'ws_1',
  name: 'Test',
  platform: 'shopify',
  domains: ['testshop.de'],
  currency: 'EUR',
  timezone: 'Europe/Berlin',
  publicKey: 'pk',
  secretKeyHash: 'x',
  settings: { ...defaultSettings },
};

function tables(rows: { costs?: unknown[]; manual?: unknown[] }) {
  return {
    query: async (sql: string): Promise<any[]> => {
      if (sql.includes('from manual_costs')) return rows.manual ?? [];
      if (sql.includes('from costs') && !sql.includes('as day')) return rows.costs ?? [];
      return [];
    },
  };
}

describe('Auswertung', () => {
  const from = '2026-11-01';
  const to = '2026-11-30';
  const fromTs = Date.parse('2026-10-31T23:00:00Z');
  const orderTs = fromTs + 5 * DAY;
  const params: ReportParams = { from, to, windowDays: 30, basis: 'conversion', model: 'last_click', ignoreDirect: true, extrapolate: true };

  const orderRow = (id: string, revenue: number, isNew: boolean): OrderRow => ({
    id,
    externalId: id,
    orderNumber: null,
    createdAt: orderTs,
    revenue,
    grossTotal: revenue,
    refunded: 0,
    currency: 'EUR',
    isNew,
    visitorId: null,
    emailHash: null,
    customerKey: null,
    status: 'paid',
    landingUrl: null,
    referrer: null,
  });
  const session = (id: string, channel: string, campaign: string | null = null): SessionTouch => ({
    id,
    ts: orderTs - DAY,
    channel,
    source: null,
    medium: null,
    campaign,
    content: null,
    isPaid: true,
    clickIdType: null,
    clickId: null,
    extCampaignId: null,
    extAdsetId: null,
    extAdId: null,
    visitorId: null,
    landingUrl: null,
    device: null,
  });
  const journeysFor = (orders: OrderRow[], touches: [string, SessionTouch[]][]): JourneyData => ({
    site,
    range: params,
    fromTs,
    toTs: Date.parse('2026-11-30T23:00:00Z'),
    orders,
    extraOrders: [],
    touches: new Map(touches),
  });

  it('rechnet Neukunden mit dem Anteil der nicht zugeordneten Neukunden hoch', async () => {
    const journeyData = journeysFor(
      [orderRow('o1', 100, true), orderRow('o2', 100, false), orderRow('o3', 50, true), orderRow('o4', 50, true)],
      [
        ['o1', [session('s1', 'meta')]],
        ['o2', [session('s2', 'google_ads')]],
      ],
    );
    const tree = await breakdown(tables({}), site, params, { journeyData, maxDepth: 0 });
    const total = (key: 'revenue' | 'orders' | 'newOrders') => sum(tree.rows.map((row) => row[key]));
    expect(total('revenue')).toBeCloseTo(300);
    expect(total('orders')).toBeCloseTo(4);
    expect(total('newOrders')).toBeCloseTo(3);
  });

  it('ordnet UTM Namen nur eindeutigen Kampagnen der Plattform zu', async () => {
    const cost = (campaignId: string, campaignName: string) => ({
      channel: 'meta',
      platform: 'meta',
      campaign_id: campaignId,
      campaign_name: campaignName,
      adset_id: '',
      adset_name: null,
      ad_id: '',
      ad_name: null,
      spend: 10,
      impressions: 100,
      clicks: 5,
      platform_conversions: null,
      platform_revenue: null,
    });
    const journeyData = journeysFor(
      [orderRow('o1', 100, true), orderRow('o2', 80, false)],
      [
        ['o1', [session('s1', 'meta', 'sale')]],
        ['o2', [session('s2', 'meta', 'Herbst')]],
      ],
    );
    const db = tables({ costs: [cost('1', 'Sale'), cost('2', 'SALE'), cost('3', 'Herbst')] });
    const tree = await breakdown(db, site, { ...params, extrapolate: false }, { journeyData, maxDepth: 1 });
    const campaigns = new Map(tree.rows[0].children!.map((row) => [row.key, row]));
    expect(campaigns.get('3')).toMatchObject({ orders: 1, revenue: 80, spend: 10 });
    expect(campaigns.get('name:sale')).toMatchObject({ orders: 1, revenue: 100, spend: 0 });
    expect(campaigns.get('1')!.orders).toBe(0);
    expect(campaigns.get('2')!.orders).toBe(0);
  });

  it('verteilt manuelle Kosten tagesgenau über Monatsgrenzen, Zeitumstellung und lange Zeiträume', async () => {
    const manual = [
      { id: 'mc_1', channel: 'klaviyo', label: 'Agentur', amount: 310, date_from: '2026-10-01', date_to: '2026-10-31' },
      // 7305 Tage, ein Euro je Tag
      { id: 'mc_2', channel: 'other_paid', label: 'Dauerauftrag', amount: 7305, date_from: '2015-01-01', date_to: '2034-12-31' },
    ];
    const db = tables({ manual });
    const costs = await loadCosts(db, site, '2026-10-20', '2026-11-05');
    expect(costs.find((cost) => cost.campaign_id === 'manual:mc_1')!.spend).toBeCloseTo(120);
    expect(costs.find((cost) => cost.campaign_id === 'manual:mc_2')!.spend).toBeCloseTo(17);
    const daily = await dailySpend(db, site, '2026-10-20', '2026-11-05');
    expect(daily.get('2026-10-25')).toBeCloseTo(11);
    expect(daily.get('2026-10-31')).toBeCloseTo(11);
    expect(daily.get('2026-11-01')).toBeCloseTo(1);
    expect(sum([...daily.values()])).toBeCloseTo(137);
  });

  it('blickt bei unbegrenztem Fenster für alle Abfragen gleich weit zurück', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const recorder = {
      query: async (sql: string, params: unknown[] = []): Promise<any[]> => {
        queries.push({ sql, params });
        return [];
      },
    };
    const journeyData = await loadJourneyData(recorder, site, { from: '2025-01-01', to: '2025-01-31', windowDays: null, basis: 'touch' });
    await markovWeights(recorder, journeyData, true);
    const [, laterOrders] = queries.filter((query) => query.sql.includes('from orders'));
    expect((laterOrders.params[2] as Date).getTime()).toBeGreaterThan(journeyData.toTs + 90 * DAY);
    const pathsWithoutPurchase = queries.find((query) => query.sql.includes('from sessions'))!;
    expect((pathsWithoutPurchase.params[1] as Date).getTime()).toBe(journeyData.fromTs - 730 * DAY);
  });
});
