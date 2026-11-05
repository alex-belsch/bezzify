import { describe, expect, it } from 'vitest';
import type { SessionTouch } from '../src/attribution/engine.js';
import { awinCosts, awinFeedback } from '../src/integrations/awin.js';
import { buildFeedbackOrder } from '../src/integrations/outbox.js';
import { googleCosts, googleFeedback } from '../src/integrations/google.js';
import { metaCosts, metaFeedback } from '../src/integrations/meta.js';
import { pinterestCosts, pinterestFeedback } from '../src/integrations/pinterest.js';
import { tiktokCosts, tiktokFeedback } from '../src/integrations/tiktok.js';
import type { FeedbackOrder } from '../src/integrations/types.js';
import { defaultSettings, type Site } from '../src/sites.js';

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

type Route = (url: URL, init: any) => unknown;
function mockFetch(routes: [string, Route][]) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (input: string, init: any = {}) => {
    calls.push({ url: String(input), init });
    const route = routes.find(([pattern]) => String(input).includes(pattern));
    if (!route) return new Response('not found', { status: 404 });
    const reply = route[1](new URL(String(input)), init);
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const touch = (channel: string, clickIdType: string | null, clickId: string | null, hoursBefore: number, base: number): SessionTouch => ({
  id: `s_${channel}_${hoursBefore}`,
  ts: base - hoursBefore * 3600_000,
  channel,
  source: null,
  medium: null,
  campaign: null,
  content: null,
  isPaid: channel !== 'direct',
  clickIdType,
  clickId,
  extCampaignId: null,
  extAdsetId: null,
  extAdId: null,
  visitorId: 'v1',
  landingUrl: null,
  device: null,
});

function order(journey: SessionTouch[], createdAt: number): FeedbackOrder {
  return {
    externalId: '1001',
    orderNumber: '#1001',
    createdAt: new Date(createdAt),
    currency: 'EUR',
    value: 119,
    total: 119,
    tax: 19,
    shipping: 5,
    items: [{ id: '1', sku: 'SKU1', name: 'Set', quantity: 2, price: 57 }],
    emailHash: 'a'.repeat(64),
    phoneHash: null,
    externalIdHash: 'b'.repeat(64),
    isNew: true,
    consentMarketing: true,
    match: { ip: '203.0.113.9', ua: 'Mozilla/5.0 Test' },
    journey,
    landingUrl: 'https://testshop.de/',
  };
}

describe('Kostenimport', () => {
  it('Meta: blättert über alle Seiten und liest Käufe der Plattform', async () => {
    const page2 = 'https://graph.facebook.com/v26.0/act_1/insights?after=abc';
    const { fn, calls } = mockFetch([
      ['after=abc', () => ({ data: [{ date_start: '2026-11-02', campaign_id: 'c', adset_id: 's', ad_id: 'a2', spend: '5.5', impressions: '100', inline_link_clicks: '4' }] })],
      ['/insights', () => ({
        data: [{ date_start: '2026-11-01', campaign_id: 'c', campaign_name: 'K', adset_id: 's', adset_name: 'S', ad_id: 'a1', ad_name: 'A', spend: '12.34', impressions: '1000', inline_link_clicks: '30', actions: [{ action_type: 'omni_purchase', value: '3' }], action_values: [{ action_type: 'omni_purchase', value: '150.5' }] }],
        paging: { next: page2 },
      })],
    ]);
    const rows = await metaCosts({ fetch: fn, site }, { ad_account_id: 'act_1', access_token: 'tok' }, '2026-11-01', '2026-11-02');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('level=ad');
    expect(calls[0].url).toContain('time_increment=1');
    // archivierte und gelöschte Anzeigen gehören dazu, sonst fehlen ihre Kosten
    const filtering = JSON.parse(new URL(calls[0].url).searchParams.get('filtering')!);
    expect(filtering[0]).toMatchObject({ field: 'ad.effective_status', operator: 'IN' });
    expect(filtering[0].value).toEqual(expect.arrayContaining(['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED']));
    expect(rows[0]).toMatchObject({ date: '2026-11-01', adId: 'a1', spend: 12.34, clicks: 30, platformConversions: 3, platformRevenue: 150.5 });
    expect(rows[1]).toMatchObject({ adId: 'a2', spend: 5.5 });
  });

  it('bricht ab, statt nach der letzten erlaubten Seite nur einen Teil der Kosten zu liefern', async () => {
    const { fn, calls } = mockFetch([['/insights', () => ({ data: [], paging: { next: 'https://graph.facebook.com/v26.0/act_1/insights?after=x' } })]]);
    await expect(metaCosts({ fetch: fn, site }, { ad_account_id: '1', access_token: 'tok' }, '2026-11-01', '2026-11-02')).rejects.toThrow(/Seiten/);
    expect(calls).toHaveLength(500);
  });

  it('Google: holt Token, liest Anzeigen und bildet Restzeilen für Performance Max', async () => {
    const { fn, calls } = mockFetch([
      ['oauth2.googleapis.com/token', () => ({ access_token: 'ya29' })],
      ['googleAds:searchStream', (_url, init) => {
        const query = JSON.parse(init.body).query as string;
        if (query.includes('FROM ad_group_ad')) {
          return [{ results: [{ segments: { date: '2026-11-01' }, campaign: { id: '1', name: 'Search' }, adGroup: { id: '11', name: 'AG' }, adGroupAd: { ad: { id: '111' } }, metrics: { costMicros: '2500000', impressions: '100', clicks: '10', conversions: 1, conversionsValue: 50 } }] }];
        }
        if (query.includes('FROM campaign')) {
          return [{ results: [
            { segments: { date: '2026-11-01' }, campaign: { id: '1', name: 'Search' }, metrics: { costMicros: '2500000', impressions: '100', clicks: '10' } },
            { segments: { date: '2026-11-01' }, campaign: { id: '2', name: 'PMax' }, metrics: { costMicros: '7000000', impressions: '900', clicks: '20', conversions: 2, conversionsValue: 80 } },
          ] }];
        }
        return [{ results: [{ customer: { currencyCode: 'EUR' } }] }];
      }],
    ]);
    const rows = await googleCosts({ fetch: fn, site }, { customer_id: '123-456-7890', login_customer_id: '999-000-1111', developer_token: 'dev', client_id: 'c', client_secret: 's', refresh_token: 'r' }, '2026-11-01', '2026-11-01');
    const searchCall = calls.find((c) => c.url.includes('searchStream'))!;
    expect(searchCall.url).toContain('/v26/customers/1234567890/');
    expect(searchCall.init.headers['developer-token']).toBe('dev');
    expect(searchCall.init.headers['login-customer-id']).toBe('9990001111');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ campaignId: '1', adId: '111', spend: 2.5 });
    expect(rows[1]).toMatchObject({ campaignId: '2', adId: '', spend: 7, platformConversions: 2 });
  });

  it('TikTok: liest alle Seiten mit Access Token', async () => {
    const { fn, calls } = mockFetch([
      ['report/integrated/get', (url) => ({
        code: 0,
        message: 'OK',
        data: {
          list: [{ dimensions: { ad_id: `ad${url.searchParams.get('page')}`, stat_time_day: '2026-11-01 00:00:00' }, metrics: { spend: '9.5', impressions: '500', clicks: '7', campaign_id: 'c1', adgroup_id: 'g1', ad_name: 'Hack' } }],
          page_info: { page: Number(url.searchParams.get('page')), total_page: 2 },
        },
      })],
    ]);
    const rows = await tiktokCosts({ fetch: fn, site }, { advertiser_id: '42', access_token: 'tt' }, '2026-11-01', '2026-11-01');
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers['Access-Token']).toBe('tt');
    const filtering = JSON.parse(new URL(calls[0].url).searchParams.get('filtering')!);
    expect(filtering).toEqual([{ field_name: 'ad_status', filter_type: 'IN', filter_value: '["STATUS_ALL"]' }]);
    expect(rows.map((r) => r.adId)).toEqual(['ad1', 'ad2']);
    expect(rows[0]).toMatchObject({ date: '2026-11-01', spend: 9.5, campaignId: 'c1', adsetId: 'g1' });
  });

  it('Pinterest: verbindet Namen und rechnet Mikro Beträge um, auch für archivierte Anzeigen', async () => {
    const { fn, calls } = mockFetch([
      ['/campaigns', () => ({ items: [{ id: 'c1', name: 'Kampagne' }], bookmark: null })],
      ['/ad_groups', () => ({ items: [{ id: 'g1', name: 'Gruppe' }], bookmark: null })],
      ['/ads/analytics', () => [
        { AD_ID: 'a1', DATE: '2026-11-01', SPEND_IN_MICRO_DOLLAR: 4_200_000, IMPRESSION_1: 300, CLICKTHROUGH_1: 6 },
        { AD_ID: 'a2', DATE: '2026-11-01', SPEND_IN_MICRO_DOLLAR: 1_000_000, IMPRESSION_1: 50, CLICKTHROUGH_1: 1 },
      ]],
      ['/ads', (url) => {
        const statuses = url.searchParams.getAll('entity_statuses');
        const items = [{ id: 'a1', name: 'Pin', campaign_id: 'c1', ad_group_id: 'g1' }];
        if (statuses.includes('ARCHIVED')) items.push({ id: 'a2', name: 'Alt', campaign_id: 'c1', ad_group_id: 'g1' });
        return { items, bookmark: null };
      }],
    ]);
    const rows = await pinterestCosts({ fetch: fn, site }, { ad_account_id: '77', access_token: 'p' }, '2026-11-01', '2026-11-01');
    expect(rows).toEqual([
      expect.objectContaining({ campaignName: 'Kampagne', adsetName: 'Gruppe', adName: 'Pin', spend: 4.2, clicks: 6 }),
      expect.objectContaining({ adId: 'a2', adName: 'Alt', spend: 1 }),
    ]);
    for (const path of ['/campaigns', '/ad_groups', '/ads?']) {
      const call = calls.find((c) => c.url.includes(path))!;
      expect(new URL(call.url).searchParams.getAll('entity_statuses')).toEqual(['ACTIVE', 'PAUSED', 'ARCHIVED']);
    }
    const analytics = new URL(calls.find((c) => c.url.includes('/ads/analytics'))!.url);
    expect(analytics.searchParams.getAll('ad_ids')).toEqual(['a1', 'a2']);
  });

  it('Awin: summiert Provisionen je Tag und Publisher ohne abgelehnte', async () => {
    const { fn, calls } = mockFetch([
      ['/transactions/', () => [
        { publisherId: 5, transactionDate: '2026-11-01T10:00:00', commissionAmount: { amount: 4, currency: 'EUR' }, saleAmount: { amount: 50 }, commissionStatus: 'pending' },
        { publisherId: 5, transactionDate: '2026-11-01T12:00:00', commissionAmount: { amount: 6, currency: 'EUR' }, saleAmount: { amount: 70 }, commissionStatus: 'approved' },
        { publisherId: 5, transactionDate: '2026-11-01T13:00:00', commissionAmount: { amount: 9 }, saleAmount: { amount: 90 }, commissionStatus: 'declined' },
      ]],
    ]);
    const rows = await awinCosts({ fetch: fn, site }, { advertiser_id: '14583', api_token: 'aw' }, '2026-11-01', '2026-11-01');
    expect(calls[0].init.headers.authorization).toBe('Bearer aw');
    expect(rows).toEqual([expect.objectContaining({ date: '2026-11-01', campaignId: '5', spend: 10, platformConversions: 2, platformRevenue: 120 })]);
  });

  it('Awin: fragt in UTC ab, rechnet Tage in die Zeitzone des Shops um und ignoriert gelöschte', async () => {
    const { fn, calls } = mockFetch([
      ['/transactions/', () => [
        { publisherId: 7, transactionDate: '2026-10-31T23:30:00', commissionAmount: { amount: 3, currency: 'EUR' }, saleAmount: { amount: 30 }, commissionStatus: 'approved' },
        { publisherId: 7, transactionDate: '2026-11-01T22:30:00', commissionAmount: { amount: 2, currency: 'EUR' }, saleAmount: { amount: 20 }, commissionStatus: 'pending' },
        { publisherId: 7, transactionDate: '2026-11-01T12:00:00', commissionAmount: { amount: 9 }, saleAmount: { amount: 90 }, commissionStatus: 'deleted' },
      ]],
    ]);
    const viennaSite: Site = { ...site, timezone: 'Europe/Vienna' };
    const rows = await awinCosts({ fetch: fn, site: viennaSite }, { advertiser_id: '14583', api_token: 'aw' }, '2026-11-01', '2026-11-01');
    const query = new URL(calls[0].url).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({ startDate: '2026-10-31T23:00:00', endDate: '2026-11-01T22:59:59', timezone: 'UTC' });
    expect(rows).toEqual([expect.objectContaining({ date: '2026-11-01', campaignId: '7', spend: 5, platformConversions: 2, platformRevenue: 50 })]);
    // 31 Tage je Abfrage, auch über die Zeitumstellung hinweg
    const { fn: longFetch, calls: longCalls } = mockFetch([['/transactions/', () => []]]);
    await awinCosts({ fetch: longFetch, site: viennaSite }, { advertiser_id: '1', api_token: 'aw' }, '2026-09-01', '2026-11-30');
    for (const call of longCalls) {
      const range = new URL(call.url).searchParams;
      const span = Date.parse(`${range.get('endDate')}Z`) - Date.parse(`${range.get('startDate')}Z`);
      expect(span).toBeLessThan(31 * 86_400_000);
    }
  });
});

describe('Rückspielung', () => {
  const now = Date.now();

  it('Awin: Kanal aw nur, wenn Awin der letzte bezahlte Klick war', async () => {
    const { fn, calls } = mockFetch([['/s2s/advertiser/', () => ({ ok: true })]]);
    const settings = { advertiser_id: '14583', conversion_api_key: 'key' };
    await awinFeedback({ fetch: fn, site }, settings, order([touch('awin', 'awc', '14583_1_x', 48, now), touch('direct', null, null, 1, now)], now));
    await awinFeedback({ fetch: fn, site }, settings, order([touch('awin', 'awc', '14583_1_x', 48, now), touch('meta', 'fbclid', 'IwAR', 2, now)], now));
    const outcome = await awinFeedback({ fetch: fn, site }, settings, order([touch('meta', 'fbclid', 'IwAR', 2, now)], now));
    expect(outcome.status).toBe('skipped');
    const bodies = calls.map((c) => JSON.parse(c.init.body).orders[0]);
    expect(bodies[0]).toMatchObject({ channel: 'aw', awc: '14583_1_x', amount: 95, customerAcquisition: 'NEW' });
    expect(bodies[1].channel).toBe('other');
    expect(calls[0].init.headers['x-api-key']).toBe('key');
  });

  it('Awin: findet Klicks auch bei einer Cookie Laufzeit über 90 Tage', async () => {
    const createdAt = new Date(now - 3600_000);
    const clickTs = now - 100 * 86_400_000;
    const tables = {
      query: async (sql: string, params: unknown[] = []): Promise<any[]> => {
        if (sql.includes('from sites')) return [{ id: site.id, workspace_id: 'ws_1', domains: [], currency: 'EUR', timezone: site.timezone, settings: {} }];
        if (sql.includes('from orders')) {
          return [{ id: 'ord_1', external_id: '1001', created_at: createdAt, total: '119', tax: '19', shipping: '5', refunded: '0', currency: 'EUR', visitor_id: 'v1', status: 'paid' }];
        }
        if (sql.includes('from sessions') && clickTs >= (params[2] as Date).getTime()) {
          return [{ id: 's_awin', visitor_id: 'v1', started_at: new Date(clickTs), channel: 'awin', is_paid: true, click_id_type: 'awc', click_id: '14583_1_alt' }];
        }
        return [];
      },
    };
    const feedbackOrder = await buildFeedbackOrder(tables, site.id, 'ord_1');
    expect(feedbackOrder!.journey.map((t) => t.clickId)).toEqual(['14583_1_alt']);
    const { fn, calls } = mockFetch([['/s2s/advertiser/', () => ({ ok: true })]]);
    const outcome = await awinFeedback({ fetch: fn, site }, { advertiser_id: '14583', conversion_api_key: 'key', cookie_days: '120' }, feedbackOrder!);
    expect(outcome.status).toBe('sent');
    expect(JSON.parse(calls[0].init.body).orders[0].awc).toBe('14583_1_alt');
  });

  it('Google: nutzt den letzten Google Klick und meldet Teilfehler', async () => {
    let fail = false;
    const { fn, calls } = mockFetch([
      ['oauth2.googleapis.com/token', () => ({ access_token: 'ya29' })],
      ['uploadClickConversions', () => (fail ? { partialFailureError: { code: 3, message: 'CLICK_NOT_FOUND' } } : { results: [{}] })],
    ]);
    const settings = { customer_id: '1234567890', developer_token: 'd', client_id: 'c', client_secret: 's', refresh_token: 'r', conversion_action_id: '555' };
    const purchase = order([touch('google_ads', 'gbraid', 'GB1', 30, now), touch('google_ads', 'gclid', 'GC2', 3, now)], now);
    const outcome = await googleFeedback({ fetch: fn, site }, settings, purchase);
    expect(outcome.status).toBe('sent');
    const conversion = JSON.parse(calls.find((c) => c.url.includes('upload'))!.init.body).conversions[0];
    expect(conversion).toMatchObject({ gclid: 'GC2', conversionAction: 'customers/1234567890/conversionActions/555', currencyCode: 'EUR', orderId: '1001' });
    expect(conversion.conversionDateTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    // Einwilligung kommt aus der Bestellung, adPersonalization gibt es für Klick Conversions nicht
    expect(conversion.consent).toEqual({ adUserData: 'GRANTED' });
    const uploads = () => calls.filter((c) => c.url.includes('upload')).map((c) => JSON.parse(c.init.body).conversions[0]);
    await googleFeedback({ fetch: fn, site }, settings, { ...purchase, consentMarketing: false });
    expect(uploads().at(-1).consent).toEqual({ adUserData: 'DENIED' });
    await googleFeedback({ fetch: fn, site }, settings, { ...purchase, consentMarketing: null });
    expect(uploads().at(-1).consent).toBeUndefined();
    fail = true;
    await expect(googleFeedback({ fetch: fn, site }, settings, purchase)).rejects.toThrow(/CLICK_NOT_FOUND/);
    expect((await googleFeedback({ fetch: fn, site }, settings, order([touch('meta', 'fbclid', 'x', 3, now)], now))).status).toBe('skipped');
  });

  it('Meta: sendet Website Käufe nur mit User Agent', async () => {
    const { fn, calls } = mockFetch([['/events', () => ({ events_received: 1 })]]);
    const purchase = order([touch('meta', 'fbclid', 'FB1', 2, now)], now);
    expect((await metaFeedback({ fetch: fn, site }, { pixel_id: '42', access_token: 'EAA' }, purchase)).status).toBe('sent');
    expect(JSON.parse(calls[0].init.body).data[0]).toMatchObject({ action_source: 'website', user_data: { client_user_agent: 'Mozilla/5.0 Test' } });
    const withoutUa = { ...purchase, match: { ip: '203.0.113.9' } };
    expect((await metaFeedback({ fetch: fn, site }, { pixel_id: '42', access_token: 'EAA' }, withoutUa)).status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('TikTok und Pinterest: senden Kauf mit Klick IDs', async () => {
    const { fn, calls } = mockFetch([
      ['event/track', () => ({ code: 0, message: 'OK' })],
      ['/events', () => ({ num_events_received: 1 })],
    ]);
    const purchase = order([touch('tiktok', 'ttclid', 'TT1', 5, now), touch('pinterest', 'epik', 'EP1', 2, now)], now);
    purchase.phoneHash = 'c'.repeat(64);
    purchase.match = { ...purchase.match, phE164: 'd'.repeat(64) };
    await tiktokFeedback({ fetch: fn, site }, { pixel_code: 'PX', events_access_token: 'ev' }, purchase);
    await pinterestFeedback({ fetch: fn, site }, { ad_account_id: '77', conversion_token: 'ct', test_mode: true }, purchase);
    const tiktokBody = JSON.parse(calls[0].init.body);
    expect(tiktokBody).toMatchObject({ event_source: 'web', event_source_id: 'PX' });
    // TikTok hasht die Nummer mit Pluszeichen, der Hash ohne Pluszeichen ist für Meta und Pinterest
    expect(tiktokBody.data[0]).toMatchObject({ event: 'Purchase', event_id: '1001', user: { ttclid: 'TT1', email: 'a'.repeat(64), phone: 'd'.repeat(64) } });
    expect(calls[1].url).toContain('/ad_accounts/77/events?test=true');
    const pinterestEvent = JSON.parse(calls[1].init.body).data[0];
    expect(pinterestEvent).toMatchObject({ event_name: 'checkout', action_source: 'web', opt_out: false, user_data: { click_id: 'EP1' }, custom_data: { value: '119', order_id: '1001' } });
    await pinterestFeedback({ fetch: fn, site }, { ad_account_id: '77', conversion_token: 'ct' }, { ...purchase, consentMarketing: false });
    expect(JSON.parse(calls[2].init.body).data[0].opt_out).toBe(true);
  });
});
