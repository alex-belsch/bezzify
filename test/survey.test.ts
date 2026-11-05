import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, createWorkspace } from '../src/api/auth.js';
import { createApp } from '../src/app.js';
import type { AttributionResult, Credit, CustomerGroup, SessionTouch } from '../src/attribution/engine.js';
import { distributeUnattributed, surveyCorrection } from '../src/attribution/extrapolation.js';
import { closeDb, db, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { cleanup } from '../src/jobs.js';
import { hmacSha256 } from '../src/lib/crypto.js';
import { saveIntegration } from '../src/integrations/store.js';
import { clearSiteCache, createSite, defaultSurvey, type Site } from '../src/sites.js';

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function credit(channel: string, customer: CustomerGroup, revenue = 100, share = 1): Credit {
  return {
    orderId: `${channel}-${Math.random()}`,
    orderTs: 0,
    touchTs: 0,
    share,
    revenue,
    isNew: customer === 'new',
    customer,
    firstChannel: channel,
    touch: { channel } as SessionTouch,
  };
}

function attribution(credits: Credit[], missing: Partial<Record<CustomerGroup, { orders: number; revenue: number }>>): AttributionResult {
  const totals = (group: CustomerGroup) => {
    const { orders = 0, revenue = 0 } = missing[group] ?? {};
    return { orders, revenue, newOrders: group === 'new' ? orders : 0 };
  };
  const byCustomer = { new: totals('new'), returning: totals('returning'), unknown: totals('unknown') };
  const all = Object.values(byCustomer);
  return {
    credits,
    attributedOrders: credits.length,
    unattributed: {
      orders: sum(all.map((t) => t.orders)),
      revenue: sum(all.map((t) => t.revenue)),
      newOrders: byCustomer.new.newOrders,
      byCustomer,
    },
  };
}

describe('Hochrechnung', () => {
  it('verteilt Käufe ohne Journey nach Kundengruppe und behält die Summen', () => {
    const credits = [credit('meta', 'new'), credit('meta', 'new'), credit('klaviyo', 'returning'), credit('klaviyo', 'returning', 50)];
    const attributed = attribution(credits, { returning: { orders: 4, revenue: 300 }, new: { orders: 2, revenue: 120 } });
    const { extras, pooled } = distributeUnattributed(attributed, new Map());
    expect(pooled).toEqual([]);
    const byChannel = (channel: string, key: 'orders' | 'revenue' | 'newOrders') =>
      sum(credits.map((c, i) => (c.touch.channel === channel ? extras[i][key] : 0)));
    // wiederkehrende Kunden ohne Einwilligung landen bei Klaviyo, neue bei Meta, nicht im Gesamtmix
    expect(byChannel('klaviyo', 'orders')).toBeCloseTo(4);
    expect(byChannel('meta', 'orders')).toBeCloseTo(2);
    expect(byChannel('meta', 'newOrders')).toBeCloseTo(2);
    expect(byChannel('klaviyo', 'newOrders')).toBeCloseTo(0);
    // Umsatz nach Umsatzanteil innerhalb der Gruppe: 100 zu 50
    expect(extras[2].revenue).toBeCloseTo(200);
    expect(extras[3].revenue).toBeCloseTo(100);
    expect(sum(extras.map((e) => e.revenue))).toBeCloseTo(420);
  });

  it('nimmt die Verteilung aller Käufe, wenn eine Kundengruppe keinen zugeordneten Kauf hat', () => {
    const credits = [credit('meta', 'returning'), credit('google_ads', 'unknown', 100, 0.5), credit('organic_search', 'unknown', 100, 0.5)];
    const { extras, pooled } = distributeUnattributed(attribution(credits, { new: { orders: 4, revenue: 400 } }), new Map());
    expect(pooled).toEqual(['new']);
    expect(extras.map((e) => e.orders)).toEqual([2, 1, 1]);
    expect(sum(extras.map((e) => e.newOrders))).toBeCloseTo(4);
  });

  it('verschiebt die Verteilung zu Kanälen, die Käufer ohne Einwilligung häufiger nennen', () => {
    const tallies = [
      { answer: 'google', tracked: true, n: 80 },
      { answer: 'instagram_facebook', tracked: true, n: 20 },
      { answer: 'google', tracked: false, n: 20 },
      { answer: 'instagram_facebook', tracked: false, n: 80 },
    ];
    const correction = surveyCorrection(defaultSurvey, tallies);
    expect(correction.tracked).toBe(100);
    expect(correction.untracked).toBe(100);
    expect(correction.deviation).toBeCloseTo(0.6);
    expect(correction.factors.get('meta')!).toBeGreaterThan(2);
    expect(correction.factors.get('google_ads')!).toBeLessThan(0.5);

    const credits = [...Array.from({ length: 8 }, () => credit('google_ads', 'new')), credit('meta', 'new'), credit('meta', 'new')];
    const { extras } = distributeUnattributed(attribution(credits, { new: { orders: 10, revenue: 1000 } }), correction.factors);
    const meta = sum(extras.slice(8).map((e) => e.orders));
    // ohne Umfrage bekäme Meta 2 der 10 Käufe
    expect(meta).toBeGreaterThan(4);
    expect(sum(extras.map((e) => e.orders))).toBeCloseTo(10);
  });

  it('gewichtet den ganzen Kauf nach seinem Einstieg, nicht nach dem Kanal, der ihn abschließt', () => {
    const viaMeta = { ...credit('google_ads', 'new'), firstChannel: 'meta' };
    const viaSearch = credit('google_ads', 'new');
    const { extras } = distributeUnattributed(attribution([viaMeta, viaSearch], { new: { orders: 4, revenue: 400 } }), new Map([['meta', 3]]));
    expect(extras[0].orders).toBeCloseTo(3);
    expect(extras[1].orders).toBeCloseTo(1);
  });

  it('lässt sich von wenigen Antworten kaum bewegen', () => {
    const correction = surveyCorrection(defaultSurvey, [
      { answer: 'google', tracked: true, n: 1 },
      { answer: 'tiktok', tracked: false, n: 1 },
    ]);
    for (const factor of correction.factors.values()) {
      expect(factor).toBeGreaterThan(0.8);
      expect(factor).toBeLessThan(1.25);
    }
  });

  it('ordnet Kanäle ohne eigene Antwort der Antwort ohne Kanäle zu und korrigiert ohne Antworten beider Gruppen nichts', () => {
    const correction = surveyCorrection(defaultSurvey, [
      { answer: 'other', tracked: true, n: 10 },
      { answer: 'google', tracked: true, n: 90 },
      { answer: 'other', tracked: false, n: 60 },
      { answer: 'google', tracked: false, n: 40 },
    ]);
    // Microsoft Ads nennt keine Antwort, es folgt also "Anders"
    expect(correction.factors.get('microsoft_ads')!).toBeGreaterThan(1.5);
    expect(surveyCorrection(defaultSurvey, [{ answer: 'google', tracked: true, n: 50 }]).factors.size).toBe(0);
    expect(surveyCorrection(defaultSurvey, [{ answer: 'gibt_es_nicht', tracked: false, n: 50 }]).untracked).toBe(0);
  });
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ORIGIN = 'https://umfrage.de';
let app: ReturnType<typeof createApp>;
let site: Site;
let secretKey: string;
let cookie = '';

beforeAll(async () => {
  await openDb(process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL } : { dir: 'memory' });
  await migrate(db());
  const workspaceId = await createWorkspace(db(), 'Umfrage');
  await createUser(db(), { email: 'umfrage@test.de', password: 'sehr-geheim-123', workspaceId });
  ({ site, secretKey } = await createSite(db(), { workspaceId, name: 'Umfrage', platform: 'shopify', domains: ['umfrage.de'] }));
  await saveIntegration(db(), site.id, 'shopify', { values: { webhook_secret: 'whsec_umfrage' } });
  clearSiteCache();
  app = createApp();
  const login = await app.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'umfrage@test.de', password: 'sehr-geheim-123' }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

afterAll(async () => {
  await closeDb();
});

const ev = (n: string, u: string, p: Record<string, unknown> = {}) => ({ n, id: crypto.randomUUID(), t: Date.now(), u, r: null, p });

function collect(body: Record<string, unknown>) {
  return app.request('/v1/collect', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'user-agent': UA, origin: ORIGIN },
    body: JSON.stringify({ k: site.publicKey, c: 1, ...body }),
  });
}

function apiOrder(body: Record<string, unknown>) {
  return app.request('/v1/orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currency: 'EUR', ...body }),
  });
}

function serverAnswer(orderId: string, answer: string, key = secretKey) {
  return app.request(`/v1/orders/${orderId}/survey`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
}

function publicAnswer(body: Record<string, unknown>) {
  return app.request('/v1/survey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const dashboard = (path: string, init: RequestInit = {}) =>
  app.request(`/api${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', 'x-bezzify': '1', ...init.headers } });

async function enableSurvey(enabled = true) {
  const response = await dashboard(`/sites/${site.id}`, {
    method: 'PUT',
    body: JSON.stringify({ settings: { survey: { ...defaultSurvey, enabled } } }),
  });
  expect(response.status).toBe(200);
}

describe('Umfrage', () => {
  it('liefert die Frage erst, wenn sie eingeschaltet ist, und nie die Kanalzuordnung', async () => {
    const off = await app.request(`/v1/survey?k=${site.publicKey}`);
    expect(off.headers.get('access-control-allow-origin')).toBe('*');
    expect(await off.json()).toEqual({ enabled: false });
    await enableSurvey();
    const on = await (await app.request(`/v1/survey?k=${site.publicKey}`)).json();
    expect(on.question).toBe(defaultSurvey.question);
    expect(on.answers[0]).toEqual({ id: 'google', label: 'Google Suche' });
    expect(JSON.stringify(on)).not.toContain('channels');
    expect((await app.request('/v1/survey?k=pk_gibtesnicht')).status).toBe(404);
    const preflight = await app.request('/v1/survey', { method: 'OPTIONS', headers: { origin: 'null' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('prüft Antworten in den Einstellungen', async () => {
    const broken = await dashboard(`/sites/${site.id}`, {
      method: 'PUT',
      body: JSON.stringify({ settings: { survey: { ...defaultSurvey, answers: [{ id: 'a', label: 'A', channels: ['gibt_es_nicht'] }] } } }),
    });
    expect(broken.status).toBe(400);
  });

  it('nimmt Antworten der Danke Seite nur mit Checkout Token an und behält die erste', async () => {
    const token = 'c1a2b3c4d5e6f708192a3b4c5d6e7f80';
    expect((await publicAnswer({ k: site.publicKey, checkout_token: token, answer: 'tiktok' })).status).toBe(204);
    expect((await publicAnswer({ k: site.publicKey, checkout_token: token, answer: 'google' })).status).toBe(204);
    expect((await publicAnswer({ k: site.publicKey, answer: 'google' })).status).toBe(400);
    expect((await publicAnswer({ k: site.publicKey, checkout_token: token, answer: 'fernsehen' })).status).toBe(400);
    const [stored] = await db().query('select answer from survey_answers where site_id = $1 and ref = $2', [site.id, `checkout:${token}`]);
    expect(stored.answer).toBe('tiktok');

    // die Bestellung kommt erst danach per Webhook
    const raw = JSON.stringify({ id: 9101, created_at: new Date().toISOString(), total_price: '30.00', financial_status: 'paid', checkout_token: token });
    const webhook = await app.request(`/webhooks/shopify/${site.id}`, {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': hmacSha256('whsec_umfrage', raw).toString('base64'), 'x-shopify-topic': 'orders/create' },
      body: raw,
    });
    expect(webhook.status).toBe(200);
    const setup = await (await dashboard(`/setup?site=${site.id}`)).json();
    expect(setup.survey.stats).toMatchObject({ answers: 1, untracked: 1, unmatched: 0 });
  });

  it('nimmt Antworten vom Server nur mit Secret Key und bekannter Antwort an', async () => {
    expect((await serverAnswer('S-1', 'google', 'sk_falsch')).status).toBe(401);
    expect((await serverAnswer('S-1', 'radio')).status).toBe(400);
    const saved = await serverAnswer('S-1', 'google');
    expect(saved.status).toBe(200);
    expect(await (await serverAnswer('S-1', 'tiktok')).json()).toMatchObject({ duplicate: true });
  });

  it('korrigiert die Hochrechnung mit den Antworten und erklärt sie', async () => {
    // mit Einwilligung: acht über Google, zwei über Meta, alle neu
    for (let i = 0; i < 10; i++) {
      const visitor = `visitorUMFRAGE${String(i).padStart(4, '0')}`;
      const url = i < 8 ? `${ORIGIN}/?gclid=Cj0x${i}&bzf_src=google&bzf_cid=11` : `${ORIGIN}/?utm_source=meta&utm_medium=paid&bzf_src=meta&bzf_cid=22`;
      await collect({ v: visitor, e: [ev('page_view', url)] });
      expect((await apiOrder({ order_id: `MIT-${i}`, total: 100, visitor_id: visitor, is_new_customer: true })).status).toBe(200);
      expect((await serverAnswer(`MIT-${i}`, i < 8 ? 'google' : 'instagram_facebook')).status).toBe(200);
    }
    // ohne Einwilligung: keine Journey, aber die Antworten nennen meist Instagram
    for (let i = 0; i < 10; i++) {
      expect((await apiOrder({ order_id: `OHNE-${i}`, total: 100, is_new_customer: true })).status).toBe(200);
      expect((await serverAnswer(`OHNE-${i}`, i < 2 ? 'google' : 'instagram_facebook')).status).toBe(200);
    }
    const overview = await (await dashboard(`/report/overview?site=${site.id}&extrapolate=1&model=last_click`)).json();
    const channel = (key: string) => overview.channels.find((row: { key: string }) => row.key === key);
    // ohne Umfrage gingen die elf Käufe ohne Journey im Verhältnis 8 zu 2 auf, Meta käme auf 4,2
    expect(channel('meta').orders).toBeGreaterThan(5.3);
    expect(channel('google_ads').orders).toBeLessThan(15.7);
    expect(channel('unattributed')).toBeUndefined();
    const total = sum(overview.channels.map((row: { revenue: number }) => row.revenue));
    expect(total).toBeCloseTo(overview.kpis.revenue, 6);
    expect(overview.extrapolation.survey).toMatchObject({ applied: true, tracked: 10 });
    // dazu die Antwort aus dem Shopify Test oben, auch ohne Einwilligung
    expect(overview.extrapolation.survey.untracked).toBe(11);
    expect(overview.extrapolation.byCustomer.new).toBe(10);

    const metaOnly = await (await dashboard(`/report/breakdown?site=${site.id}&extrapolate=1&model=last_click&channel=meta`)).json();
    expect(metaOnly.rows[0].orders).toBeCloseTo(channel('meta').orders, 6);
  });

  it('löscht Antworten ohne Bestellung nach einer Woche', async () => {
    await publicAnswer({ k: site.publicKey, checkout_token: 'geraten0000000000', answer: 'google' });
    await db().query(`update survey_answers set created_at = now() - interval '8 days' where ref = 'checkout:geraten0000000000'`);
    await cleanup(db());
    const left = await db().query('select ref from survey_answers where site_id = $1 and ref = $2', [site.id, 'checkout:geraten0000000000']);
    expect(left).toEqual([]);
    const kept = await db().query('select count(*)::int as n from survey_answers where site_id = $1', [site.id]);
    expect(kept[0].n).toBeGreaterThan(20);
  });

  it('nimmt keine Antworten mehr an, wenn die Umfrage aus ist', async () => {
    await enableSurvey(false);
    expect((await publicAnswer({ k: site.publicKey, checkout_token: 'c9c9c9c9c9c9c9c9', answer: 'google' })).status).toBe(404);
  });
});
