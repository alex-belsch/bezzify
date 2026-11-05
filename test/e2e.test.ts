import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, createWorkspace } from '../src/api/auth.js';
import { createApp } from '../src/app.js';
import { closeDb, db, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { processOutbox } from '../src/integrations/outbox.js';
import { saveIntegration } from '../src/integrations/store.js';
import { hmacSha256 } from '../src/lib/crypto.js';
import { hashEmail } from '../src/lib/normalize.js';
import { clearSiteCache, createSite, type Site } from '../src/sites.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ORIGIN = 'https://testshop.de';
let app: ReturnType<typeof createApp>;
let site: Site;
let secretKey: string;
let cookie = '';

beforeAll(async () => {
  // TEST_DATABASE_URL=postgres://... prüft denselben Ablauf gegen ein echtes PostgreSQL
  await openDb(process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL } : { dir: 'memory' });
  await migrate(db());
  const ws = await createWorkspace(db(), 'Test');
  await createUser(db(), { email: 'alex@test.de', password: 'sehr-geheim-123', workspaceId: ws });
  ({ site, secretKey } = await createSite(db(), { workspaceId: ws, name: 'Testshop', platform: 'shopify', domains: ['testshop.de'] }));
  await db().query(`update sites set settings = settings || '{"feedbackDelayMinutes":0}'::jsonb where id = $1`, [site.id]);
  clearSiteCache();
  app = createApp();
});

afterAll(async () => {
  await closeDb();
});

function collect(body: unknown, origin: string | null = ORIGIN, ua = UA) {
  const headers: Record<string, string> = { 'content-type': 'text/plain', 'user-agent': ua };
  if (origin) headers.origin = origin;
  return app.request('/v1/collect', { method: 'POST', headers, body: JSON.stringify(body) });
}

const ev = (name: string, url: string, referrer: string | null = null, props: Record<string, unknown> = {}) => ({
  n: name,
  id: crypto.randomUUID(),
  t: Date.now(),
  u: url,
  r: referrer,
  p: props,
});

async function shiftVisitor(visitorId: string, days: number) {
  await db().query(
    `update sessions set started_at = started_at - make_interval(days => $2), last_seen_at = last_seen_at - make_interval(days => $2)
     where visitor_id = $1`,
    [visitorId, days],
  );
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('cookie', cookie);
  if (init.method && init.method !== 'GET') headers.set('x-bezzify', '1');
  return app.request(path, { ...init, headers });
}

describe('Tracking bis zur Attribution', () => {
  const visitorA = 'visitorAAAAAAAAAAAA';
  const visitorB = 'visitorBBBBBBBBBBBB';

  it('liefert das Tracking Skript aus', async () => {
    const response = await app.request('/t.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(await response.text()).toContain('bezzify');
  });

  it('nimmt Seitenaufrufe an und bildet Sessions je Quelle', async () => {
    const metaUrl = 'https://testshop.de/p/1?utm_source=meta&utm_medium=paid&utm_campaign=Herbst&bzf_src=meta&bzf_cid=111&bzf_gid=222&bzf_aid=333&fbclid=IwARtest';
    let response = await collect({ k: site.publicKey, v: visitorA, c: 1, e: [ev('page_view', metaUrl, 'https://l.instagram.com/')] });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    // interne Navigation bleibt in derselben Session
    response = await collect({ k: site.publicKey, v: visitorA, c: 1, e: [ev('page_view', 'https://testshop.de/cart', metaUrl), ev('identify', 'https://testshop.de/newsletter', null, { email: 'Kunde@Test.de' })] });
    expect(response.status).toBe(204);
    let sessions = await db().query('select * from sessions where visitor_id = $1', [visitorA]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ channel: 'meta', ext_campaign_id: '111', ext_ad_id: '333', pageviews: 2 });
    await shiftVisitor(visitorA, 3);

    // zweiter Besuch über Google, neue Session
    await collect({ k: site.publicKey, v: visitorA, c: 1, e: [ev('page_view', 'https://testshop.de/?gclid=Cj0test&bzf_src=google&bzf_cid=999', 'https://www.google.com/')] });
    sessions = await db().query('select channel from sessions where visitor_id = $1 order by started_at', [visitorA]);
    expect(sessions.map((session: any) => session.channel)).toEqual(['meta', 'google_ads']);
    await shiftVisitor(visitorA, 1);

    const ids = await db().query(`select value from identities where visitor_id = $1 and kind = 'email_sha256'`, [visitorA]);
    expect(ids[0].value).toBe(hashEmail('kunde@test.de'));
    const events = await db().query(`select props from events where visitor_id = $1 and name = 'identify'`, [visitorA]);
    expect(JSON.stringify(events[0].props)).not.toContain('@');
  });

  it('verknüpft einen Kauf auf einem zweiten Gerät über die Mailadresse', async () => {
    const response = await collect(
      {
        k: site.publicKey,
        v: visitorB,
        c: 1,
        mk: 1,
        m: { fbp: 'fb.1.123.456' },
        e: [
          ev('page_view', 'https://testshop.de/', null),
          ev('purchase', 'https://testshop.de/checkouts/thank-you', 'https://testshop.de/checkouts/c1', {
            order_id: 'gid://shopify/OrderIdentity/7001',
            value: 119,
            currency: 'EUR',
            email: 'kunde@test.de',
          }),
        ],
      },
      'null',
    );
    expect(response.status).toBe(204);
    const [order] = await db().query(`select * from orders where external_id = '7001'`);
    expect(order).toMatchObject({ source: 'pixel', visitor_id: visitorB, consent_marketing: true });
    expect(Number(order.total)).toBe(119);
  });

  it('übernimmt die Shopify Bestellung per Webhook mit gültiger Signatur', async () => {
    await saveIntegration(db(), site.id, 'shopify', { values: { webhook_secret: 'whsec_test' } });
    const body = JSON.stringify({
      id: 7001,
      name: '#1001',
      created_at: new Date().toISOString(),
      currency: 'EUR',
      total_price: '119.00',
      total_tax: '19.00',
      total_discounts: '0.00',
      total_shipping_price_set: { shop_money: { amount: '4.90' } },
      financial_status: 'paid',
      email: 'kunde@test.de',
      customer: { id: 555 },
      line_items: [{ product_id: 1, title: 'Starterset', quantity: 1, price: '114.10', sku: 'SET-1' }],
      browser_ip: '203.0.113.5',
      client_details: { user_agent: UA },
    });
    const bad = await app.request(`/webhooks/shopify/${site.id}`, {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': 'falsch', 'x-shopify-topic': 'orders/create' },
      body,
    });
    expect(bad.status).toBe(401);
    const signature = hmacSha256('whsec_test', body).toString('base64');
    const response = await app.request(`/webhooks/shopify/${site.id}`, {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': signature, 'x-shopify-topic': 'orders/create', 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(200);
    const orders = await db().query(`select * from orders where external_id = '7001'`);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ source: 'webhook', visitor_id: visitorB, order_number: '#1001', consent_marketing: true });
    expect(Number(orders[0].shipping)).toBe(4.9);

    const refund = JSON.stringify({ id: 9, order_id: 7001, transactions: [{ kind: 'refund', status: 'success', amount: '20.00' }] });
    const refunded = await app.request(`/webhooks/shopify/${site.id}`, {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': hmacSha256('whsec_test', refund).toString('base64'), 'x-shopify-topic': 'refunds/create' },
      body: refund,
    });
    expect(refunded.status).toBe(200);
    const [stored] = await db().query(`select refunded from orders where external_id = '7001'`);
    expect(Number(stored.refunded)).toBe(20);
  });

  it('nimmt Bestellungen über die Server API an', async () => {
    const order = { order_id: 'WC-1', total: 49.9, tax: 7.97, email: 'neu@test.de', currency: 'EUR', visitor_id: null, test: false };
    const denied = await app.request('/v1/orders', { method: 'POST', headers: { authorization: 'Bearer falsch', 'content-type': 'application/json' }, body: JSON.stringify(order) });
    expect(denied.status).toBe(401);
    const ok = await app.request('/v1/orders', { method: 'POST', headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' }, body: JSON.stringify(order) });
    expect(ok.status).toBe(200);
    const invalid = await app.request('/v1/orders', { method: 'POST', headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ order_id: 'x' }) });
    expect(invalid.status).toBe(400);
  });

  it('blockt fremde Herkunft, Bots und speichert ohne Einwilligung nichts Persönliches', async () => {
    const evil = await collect({ k: site.publicKey, v: 'visitorEVILEVILEVIL', c: 1, e: [ev('page_view', 'https://testshop.de/')] }, 'https://evil.example');
    expect(evil.status).toBe(403);
    const bot = await collect({ k: site.publicKey, v: 'visitorBOTBOTBOTBOT', c: 1, e: [ev('page_view', 'https://testshop.de/')] }, ORIGIN, 'curl/8.4.0');
    expect(bot.status).toBe(204);
    expect(await db().query(`select 1 from sessions where visitor_id = 'visitorBOTBOTBOTBOT'`)).toHaveLength(0);
    const anon = await collect({ k: site.publicKey, v: 'visitorANONANONANON', c: 0, e: [ev('page_view', 'https://testshop.de/?gclid=abc', 'https://www.google.com/')] });
    expect(anon.status).toBe(204);
    const rows = await db().query(`select * from sessions where visitor_id is null`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'google_ads', click_id: null, ip_trunc: null, consent: false, referrer: 'https://www.google.com/' });
    expect(rows[0].landing_url).not.toContain('gclid');
    expect(await db().query(`select 1 from events where visitor_id = 'visitorANONANONANON'`)).toHaveLength(0);
  });

  it('meldet sich an und liefert die Auswertung', async () => {
    const wrong = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ email: 'alex@test.de', password: 'falsch' }), headers: { 'content-type': 'application/json' } });
    expect(wrong.status).toBe(401);
    const login = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ email: 'alex@test.de', password: 'sehr-geheim-123' }), headers: { 'content-type': 'application/json' } });
    expect(login.status).toBe(200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toContain('bzf_session=');

    const unauth = await app.request(`/api/report/overview?site=${site.id}`);
    expect(unauth.status).toBe(401);

    const overview = await (await api(`/api/report/overview?site=${site.id}&model=last_non_direct`)).json();
    expect(overview.kpis.orders).toBe(2);
    const google = overview.channels.find((c: any) => c.key === 'google_ads');
    expect(google.orders).toBeCloseTo(1);

    const linear = await (await api(`/api/report/overview?site=${site.id}&model=linear`)).json();
    expect(linear.channels.find((c: any) => c.key === 'meta').orders).toBeCloseTo(0.5);

    const firstClick = await (await api(`/api/report/breakdown?site=${site.id}&model=first_click&channel=meta`)).json();
    const campaign = firstClick.rows[0].children[0];
    expect(campaign).toMatchObject({ key: '111', label: 'Herbst' });
    expect(campaign.children[0].children[0].key).toBe('333');

    const journeyList = await (await api(`/api/journeys?site=${site.id}&model=linear`)).json();
    const journey = journeyList.orders.find((o: any) => o.externalId === '7001');
    expect(journey.touches.map((t: any) => t.channel)).toEqual(['meta', 'google_ads', 'direct']);

    const csrf = await app.request(`/api/sites/${site.id}`, { method: 'PUT', headers: { cookie }, body: JSON.stringify({ name: 'x' }) });
    expect(csrf.status).toBe(403);
    const setup = await (await api(`/api/setup?site=${site.id}`)).json();
    expect(setup.snippets.shopifyPixel).toContain(site.publicKey);
    expect(JSON.stringify(setup)).not.toContain('whsec_test');
  });

  it('spielt Käufe an Meta zurück und baut fbc aus dem Klick', async () => {
    await saveIntegration(db(), site.id, 'meta', {
      values: { ad_account_id: '123', access_token: 'EAAtoken', pixel_id: '987654', feedback: true },
    });
    // neue Bestellung erzeugt den Eintrag in der Warteschlange
    await collect({
      k: site.publicKey,
      v: visitorA,
      c: 1,
      mk: 1,
      e: [ev('purchase', 'https://testshop.de/checkouts/thank-you', null, { order_id: '7002', value: 60, currency: 'EUR', email: 'kunde@test.de' })],
    });
    // Bestätigung durch den Shop, sonst gilt die Bestellung als unbestätigt
    const confirm = JSON.stringify({ id: 7002, name: '#1002', created_at: new Date().toISOString(), currency: 'EUR', total_price: '60.00', total_tax: '9.58', financial_status: 'paid', email: 'kunde@test.de', line_items: [] });
    const confirmed = await app.request(`/webhooks/shopify/${site.id}`, {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': hmacSha256('whsec_test', confirm).toString('base64'), 'x-shopify-topic': 'orders/create' },
      body: confirm,
    });
    expect(confirmed.status).toBe(200);
    const calls: { url: string; body: any }[] = [];
    const fetchMock = (async (url: string, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const processed = await processOutbox(db(), { fetchFn: fetchMock });
    expect(processed).toBeGreaterThanOrEqual(1);
    const call = calls.find((c) => c.body.data?.[0]?.custom_data?.order_id === '7002')!;
    expect(call.url).toContain('/v26.0/987654/events');
    const event = call.body.data[0];
    expect(event.event_name).toBe('Purchase');
    expect(event.event_id).toBe('7002');
    expect(event.user_data.em[0]).toBe(hashEmail('kunde@test.de'));
    expect(event.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwARtest$/);
    const [entry] = await db().query(`select o.status from outbox o join orders r on r.id = o.order_id where r.external_id = '7002'`);
    expect(entry.status).toBe('sent');
  });

  it('zählt und meldet keine unbestätigten Pixel Bestellungen, sobald der Shop selbst meldet', async () => {
    await collect({
      k: site.publicKey,
      v: visitorA,
      c: 1,
      mk: 1,
      e: [ev('purchase', 'https://testshop.de/checkouts/thank-you', null, { order_id: 'FAKE-1', value: 9999, currency: 'EUR' })],
    });
    const overview = await (await api(`/api/report/overview?site=${site.id}`)).json();
    expect(overview.kpis.revenue).toBeLessThan(9999);
    const calls: string[] = [];
    const fetchMock = (async (url: string) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await processOutbox(db(), { fetchFn: fetchMock });
    const outboxOf = async () =>
      (await db().query(`select o.status, o.last_error from outbox o join orders r on r.id = o.order_id where r.external_id = 'FAKE-1'`))[0];
    // wartet auf die Bestätigung durch den Shop, statt sofort verworfen zu werden
    expect(await outboxOf()).toMatchObject({ status: 'pending', last_error: 'Wartet auf Bestätigung durch den Shop' });
    expect(calls).toHaveLength(0);
    // kommt nach Ablauf der Frist keine Bestätigung, wird nichts gesendet
    await db().query(`update orders set created_at = created_at - interval '8 days' where external_id = 'FAKE-1'`);
    await db().query(`update outbox set next_attempt_at = now() where order_id = (select id from orders where external_id = 'FAKE-1')`);
    await processOutbox(db(), { fetchFn: fetchMock });
    expect(await outboxOf()).toMatchObject({ status: 'skipped', last_error: 'Bestellung nicht vom Shop bestätigt' });
    expect(calls).toHaveLength(0);
  });
});
