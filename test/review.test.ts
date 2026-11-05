// Regressionstests zu Befunden aus dem Code Review
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, createWorkspace } from '../src/api/auth.js';
import { createApp } from '../src/app.js';
import { attachJourneys } from '../src/attribution/engine.js';
import { config } from '../src/config.js';
import { closeDb, db, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { processOutbox } from '../src/integrations/outbox.js';
import { redactSecrets, saveIntegration } from '../src/integrations/store.js';
import { syncCosts } from '../src/integrations/sync.js';
import { cleanup } from '../src/jobs.js';
import { decrypt, hmacSha256 } from '../src/lib/crypto.js';
import { RateLimiter } from '../src/lib/ratelimit.js';
import { addDays, zonedDay } from '../src/lib/time.js';
import { anonymousUrl, scrubUrl } from '../src/lib/urls.js';
import { clearSiteCache, createSite, type Site } from '../src/sites.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ORIGIN = 'https://reviewshop.de';
let app: ReturnType<typeof createApp>;
let site: Site;
let secretKey: string;
let cookie = '';

beforeAll(async () => {
  await openDb(process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL } : { dir: 'memory' });
  await migrate(db());
  const workspaceId = await createWorkspace(db(), 'Review');
  await createUser(db(), { email: 'review@test.de', password: 'sehr-geheim-123', workspaceId });
  await createUser(db(), { email: 'report@test.de', password: 'sehr-geheim-123', workspaceId });
  ({ site, secretKey } = await createSite(db(), { workspaceId, name: 'Reviewshop', platform: 'woocommerce', domains: ['reviewshop.de'] }));
  await db().query(`update sites set settings = settings || '{"feedbackDelayMinutes":0}'::jsonb where id = $1`, [site.id]);
  clearSiteCache();
  await saveIntegration(db(), site.id, 'meta', { values: { ad_account_id: '1', access_token: 'EAA', pixel_id: '42', feedback: true } });
  await saveIntegration(db(), site.id, 'shopify', { values: { webhook_secret: 'whsec_review' } });
  app = createApp();
});

afterAll(async () => {
  await closeDb();
});

const ev = (name: string, url: string, props: Record<string, unknown> = {}, referrer: string | null = null) => ({
  n: name,
  id: crypto.randomUUID(),
  t: Date.now(),
  u: url,
  r: referrer,
  p: props,
});

function collect(body: Record<string, unknown>) {
  return app.request('/v1/collect', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'user-agent': UA, origin: ORIGIN },
    body: JSON.stringify({ k: site.publicKey, ...body }),
  });
}

function apiOrder(body: Record<string, unknown>) {
  return app.request('/v1/orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currency: 'EUR', ...body }),
  });
}

function shopifyWebhook(body: Record<string, unknown>, topic = 'orders/create') {
  const raw = JSON.stringify(body);
  return app.request(`/webhooks/shopify/${site.id}`, {
    method: 'POST',
    headers: { 'x-shopify-hmac-sha256': hmacSha256('whsec_review', raw).toString('base64'), 'x-shopify-topic': topic },
    body: raw,
  });
}

const order = async (ext: string) => (await db().query('select * from orders where site_id = $1 and external_id = $2', [site.id, ext]))[0];
const outboxOf = async (ext: string) =>
  (await db().query(`select o.* from outbox o join orders r on r.id = o.order_id where r.site_id = $1 and r.external_id = $2`, [site.id, ext]))[0];

function recorder() {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

describe('Gefälschte Pixel Meldungen', () => {
  it('ändern weder Einwilligung noch Besucher einer Bestellung aus dem Shop', async () => {
    expect((await apiOrder({ order_id: '1001', total: 50, visitor_id: 'visitorSHOPSHOP0001', consent_marketing: false })).status).toBe(200);
    const response = await collect({
      v: 'visitorATTACKER0001',
      c: 1,
      mk: 1,
      m: { fbc: 'fb.1.1.ANGREIFER' },
      e: [ev('purchase', `${ORIGIN}/danke`, { order_id: '1001', value: 1 })],
    });
    expect(response.status).toBe(204);
    const stored = await order('1001');
    expect(stored).toMatchObject({ visitor_id: 'visitorSHOPSHOP0001', consent_marketing: false, source: 'api' });
    expect(Number(stored.total)).toBe(50);
    expect(decrypt<any>(stored.match_data)?.fbc).toBeUndefined();

    const { calls, fn } = recorder();
    await processOutbox(db(), { fetchFn: fn });
    expect(await outboxOf('1001')).toMatchObject({ status: 'skipped', last_error: 'Keine Einwilligung für Marketing' });
    expect(calls).toHaveLength(0);
  });

  it('verlieren ihre Angaben, wenn der Shop eine vorab beanspruchte Bestellnummer meldet', async () => {
    await collect({
      v: 'visitorATTACKER0001',
      c: 1,
      mk: 1,
      m: { fbc: 'fb.1.1.ANGREIFER' },
      e: [ev('purchase', `${ORIGIN}/danke`, { order_id: '1002', value: 1, checkout_token: 'erfunden' })],
    });
    expect(await order('1002')).toMatchObject({ source: 'pixel', visitor_id: 'visitorATTACKER0001', consent_marketing: true });
    // echte Bestellung, Kunde ohne Einwilligung
    await apiOrder({ order_id: '1002', total: 80, email: 'echt@test.de', consent_marketing: false });
    const stored = await order('1002');
    expect(stored).toMatchObject({ source: 'api', visitor_id: null, consent_marketing: false, checkout_token: null, match_data: null });
    expect(Number(stored.total)).toBe(80);
  });

  it('ergänzen eine Shop Bestellung, wenn Mailadresse oder Checkout passen', async () => {
    // bei Shopify kommt der Webhook vor dem Pixel
    await shopifyWebhook({ id: 8001, created_at: new Date().toISOString(), total_price: '30.00', financial_status: 'paid', email: 'paar@test.de', checkout_token: 'tok-8001' });
    await collect({
      v: 'visitorKUNDE000001',
      c: 1,
      mk: 1,
      m: { fbp: 'fb.1.1.kunde' },
      e: [ev('purchase', `${ORIGIN}/danke`, { order_id: 'gid://shopify/OrderIdentity/8001', value: 30, email: 'paar@test.de' })],
    });
    expect(await order('8001')).toMatchObject({ source: 'webhook', visitor_id: 'visitorKUNDE000001', consent_marketing: true });
    expect(decrypt<any>((await order('8001')).match_data)?.fbp).toBe('fb.1.1.kunde');

    // Pixel zuerst, Webhook ohne Mail, aber mit demselben Checkout
    await collect({ v: 'visitorKUNDE000002', c: 1, mk: 1, e: [ev('purchase', `${ORIGIN}/danke`, { order_id: '8002', value: 40, checkout_token: 'tok-8002' })] });
    await shopifyWebhook({ id: 8002, created_at: new Date().toISOString(), total_price: '40.00', financial_status: 'paid', checkout_token: 'tok-8002' });
    expect(await order('8002')).toMatchObject({ source: 'webhook', visitor_id: 'visitorKUNDE000002', consent_marketing: true });

    // fremder Besucher ohne passende Merkmale wird ignoriert
    await collect({ v: 'visitorATTACKER0002', c: 1, mk: 1, e: [ev('purchase', `${ORIGIN}/danke`, { order_id: '8002', value: 1 })] });
    expect(await order('8002')).toMatchObject({ visitor_id: 'visitorKUNDE000002' });
  });
});

describe('Einwilligung in zwei Stufen', () => {
  it('Statistik allein erlaubt Messung, aber keine Rückspielung und keine Merkmale', async () => {
    const response = await collect({
      v: 'visitorSTATISTIK01',
      c: 1,
      mk: 0,
      m: { fbp: 'fb.1.1.stat' },
      e: [ev('page_view', `${ORIGIN}/?utm_source=nl`), ev('purchase', `${ORIGIN}/danke`, { order_id: 'AN-1', value: 20, email: 'stat@test.de' })],
    });
    expect(response.status).toBe(204);
    const stored = await order('AN-1');
    expect(stored).toMatchObject({ visitor_id: 'visitorSTATISTIK01', consent_marketing: false, match_data: null });
    expect(await db().query('select 1 from sessions where visitor_id = $1', ['visitorSTATISTIK01'])).toHaveLength(1);
  });

  it('setzt das Einwilligungscookie passend zur Stufe', async () => {
    await db().query(`update sites set settings = settings || '{"cookieDomain":".reviewshop.de"}'::jsonb where id = $1`, [site.id]);
    clearSiteCache();
    const stat = await collect({ v: 'visitorCOOKIE00001', c: 1, mk: 0, e: [ev('page_view', `${ORIGIN}/`)] });
    expect(stat.headers.get('set-cookie')).toContain('_bzf_c=1;');
    const mk = await collect({ v: 'visitorCOOKIE00002', c: 1, mk: 1, e: [ev('page_view', `${ORIGIN}/`)] });
    expect(mk.headers.get('set-cookie')).toContain('_bzf_c=2;');
    await db().query(`update sites set settings = settings || '{"cookieDomain":null}'::jsonb where id = $1`, [site.id]);
    clearSiteCache();
  });
});

describe('Rückspielung', () => {
  it('wartet bei Pixel Bestellungen auf den Shop und sendet nach der Bestätigung', async () => {
    await collect({ v: 'visitorSPAET000001', c: 1, mk: 1, e: [ev('purchase', `${ORIGIN}/danke`, { order_id: 'LATE-1', value: 70, email: 'spaet@test.de' })] });
    const { calls, fn } = recorder();
    await processOutbox(db(), { fetchFn: fn });
    expect(await outboxOf('LATE-1')).toMatchObject({ status: 'pending', last_error: 'Wartet auf Bestätigung durch den Shop', attempts: 0 });
    // bei Vorkasse meldet der Shop die Bestellung später
    await apiOrder({ order_id: 'LATE-1', total: 70, email: 'spaet@test.de', visitor_id: 'visitorSPAET000001', consent_marketing: true });
    await processOutbox(db(), { fetchFn: fn });
    expect(await outboxOf('LATE-1')).toMatchObject({ status: 'sent' });
    const sent = calls.find((c) => c.body?.data?.[0]?.event_id === 'LATE-1');
    expect(sent).toBeTruthy();
  });

  it('speichert gelöschte IP und User Agent nicht erneut', async () => {
    await apiOrder({ order_id: 'PURGE-1', total: 10, ip: '203.0.113.20', user_agent: UA, consent_marketing: true });
    expect(decrypt<any>((await order('PURGE-1')).match_data)?.ip).toBe('203.0.113.20');
    await db().query(`update orders set match_data_at = now() - interval '8 days' where site_id = $1 and external_id = 'PURGE-1'`, [site.id]);
    await cleanup(db());
    expect((await order('PURGE-1')).match_data).toBeNull();
    // spätere Aktualisierung aus dem Shop bringt IP und User Agent wieder mit
    await apiOrder({ order_id: 'PURGE-1', total: 10, ip: '203.0.113.20', user_agent: UA, status: 'paid' });
    const stored = await order('PURGE-1');
    expect(stored.match_data).toBeNull();
    expect(stored.match_data_at).not.toBeNull();
  });
});

describe('Parallele Anfragen', () => {
  it('legen für gleichzeitige Events eines Besuchers nur eine Session an', async () => {
    const url = `${ORIGIN}/produkt?utm_source=meta&utm_medium=paid&bzf_src=meta&bzf_cid=55`;
    const results = await Promise.all([
      collect({ v: 'visitorPARALLEL001', c: 1, e: [ev('page_view', url)] }),
      collect({ v: 'visitorPARALLEL001', c: 1, e: [ev('view_item', url)] }),
      collect({ v: 'visitorPARALLEL001', c: 1, e: [ev('page_view', url)] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([204, 204, 204]);
    expect(await db().query('select 1 from sessions where visitor_id = $1', ['visitorPARALLEL001'])).toHaveLength(1);
  });

  it('verarbeiten Pixel und Webhook derselben Bestellung ohne Fehler', async () => {
    const [pixel, hook] = await Promise.all([
      collect({ v: 'visitorPARALLEL002', c: 1, mk: 1, e: [ev('purchase', `${ORIGIN}/danke`, { order_id: '9001', value: 15, email: 'gleich@test.de' })] }),
      shopifyWebhook({ id: 9001, created_at: new Date().toISOString(), total_price: '15.00', financial_status: 'paid', email: 'gleich@test.de' }),
    ]);
    expect(pixel.status).toBe(204);
    expect(hook.status).toBe(200);
    const rows = await db().query('select * from orders where site_id = $1 and external_id = $2', [site.id, '9001']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'webhook', visitor_id: 'visitorPARALLEL002' });
  });
});

describe('Datenschutz in URLs', () => {
  it('behält ohne Einwilligung nur Kampagnenparameter', async () => {
    const url = `${ORIGIN}/start?utm_source=newsletter&utm_campaign=herbst&email=kunde%40test.de&mc_eid=abc123&gclid=xyz&ref=7#token=1`;
    expect(anonymousUrl(url)).toBe(`${ORIGIN}/start?utm_source=newsletter&utm_campaign=herbst`);
    await collect({ v: null, c: 0, e: [{ n: 'page_view', t: Date.now(), u: url, r: 'https://mail.example.com/inbox?user=kunde@test.de' }] });
    const [session] = await db().query(`select landing_url, referrer from sessions where site_id = $1 and visitor_id is null and landing_url like '%newsletter%'`, [site.id]);
    expect(session).toEqual({ landing_url: `${ORIGIN}/start?utm_source=newsletter&utm_campaign=herbst`, referrer: 'https://mail.example.com/' });
  });

  it('entfernt mit Einwilligung Mailadressen und Zugangsdaten aus URLs', async () => {
    expect(scrubUrl(`${ORIGIN}/konto/passwort?key=geheim&user=kunde@test.de&gclid=abc&utm_source=x`)).toBe(`${ORIGIN}/konto/passwort?gclid=abc&utm_source=x`);
    expect(scrubUrl(`${ORIGIN}/abmelden/kunde%40test.de/ok`)).toBe(`${ORIGIN}/abmelden/(email)/ok`);
    await collect({ v: 'visitorURLS000001', c: 1, e: [ev('page_view', `${ORIGIN}/?utm_source=nl&utm_content=kunde@test.de&email=kunde@test.de`)] });
    const [session] = await db().query('select landing_url, content from sessions where visitor_id = $1', ['visitorURLS000001']);
    expect(session.landing_url).toBe(`${ORIGIN}/?utm_source=nl`);
    expect(session.content).toBeNull();
    const [event] = await db().query('select url from events where visitor_id = $1', ['visitorURLS000001']);
    expect(event.url).not.toContain('@');
  });
});

describe('Anmeldung und Rate Limits', () => {
  it('nimmt X-Forwarded-For von rechts und begrenzt Fehlversuche je Mailadresse', async () => {
    const before = config.trustProxy;
    (config as { trustProxy: number }).trustProxy = 1;
    try {
      const attempt = (xff: string, email = 'review@test.de') =>
        app.request('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
          body: JSON.stringify({ email, password: 'falsch' }),
        });
      // gefälschte linke Einträge ändern nichts, alle Versuche zählen für 198.51.100.7
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await attempt(`10.0.0.${i}, 198.51.100.7`, `andere${i}@test.de`)).status);
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes[10]).toBe(429);
      // viele echte IPs, aber dieselbe Mailadresse
      const perMail: number[] = [];
      for (let i = 0; i < 11; i++) perMail.push((await attempt(`203.0.113.${i + 1}`)).status);
      expect(perMail.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(perMail[10]).toBe(429);
      expect((await attempt('203.0.113.200', 'nochjemand@test.de')).status).toBe(401);
    } finally {
      (config as { trustProxy: number }).trustProxy = before;
    }
  });

  it('Rate Limiter zählt in Fenstern und begrenzt die Tabelle', () => {
    const limiter = new RateLimiter(2, 1000, 3);
    expect([limiter.allow('a', 0), limiter.allow('a', 1), limiter.allow('a', 2)]).toEqual([true, true, false]);
    expect(limiter.blocked('a', 3)).toBe(true);
    expect(limiter.allow('a', 1000)).toBe(true);
    limiter.allow('b', 1001);
    limiter.allow('c', 1002);
    expect(limiter.size).toBe(3);
    expect(limiter.allow('d', 1003)).toBe(true);
    expect(limiter.size).toBe(3);
  });
});

describe('Auswertung', () => {
  it('rechnet bei Filter auf einen Kanal genauso hoch wie in der Gesamtansicht', async () => {
    const login = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'report@test.de', password: 'sehr-geheim-123' }),
    });
    expect(login.status).toBe(200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    await collect({ v: 'visitorKANALMETA01', c: 1, e: [ev('page_view', `${ORIGIN}/?utm_source=meta&utm_medium=paid&bzf_src=meta&bzf_cid=71`)] });
    await collect({ v: 'visitorKANALMETA01', c: 1, e: [ev('purchase', `${ORIGIN}/danke`, { order_id: 'X-1', value: 100 })] });
    await collect({ v: 'visitorKANALGOOG01', c: 1, e: [ev('page_view', `${ORIGIN}/?gclid=Cj0x&bzf_src=google&bzf_cid=72`)] });
    await collect({ v: 'visitorKANALGOOG01', c: 1, e: [ev('purchase', `${ORIGIN}/danke`, { order_id: 'X-2', value: 300 })] });
    await apiOrder({ order_id: 'X-1', total: 100, visitor_id: 'visitorKANALMETA01' });
    await apiOrder({ order_id: 'X-2', total: 300, visitor_id: 'visitorKANALGOOG01' });
    await apiOrder({ order_id: 'X-3', total: 400 });
    const get = async (path: string) => (await app.request(path, { headers: { cookie } })).json();
    const overview = await get(`/api/report/overview?site=${site.id}&extrapolate=1&model=last_click`);
    const metaFull = overview.channels.find((c: any) => c.key === 'meta').revenue;
    const metaOnly = await get(`/api/report/breakdown?site=${site.id}&extrapolate=1&model=last_click&channel=meta`);
    expect(metaOnly.rows[0].key).toBe('meta');
    expect(metaOnly.rows[0].revenue).toBeCloseTo(metaFull, 6);
    const total = overview.channels.reduce((s: number, c: any) => s + c.revenue, 0);
    expect(total).toBeCloseTo(overview.kpis.revenue, 6);
  });

  it('verarbeitet sehr viele Bestellungen ohne RangeError', async () => {
    const emptyDb = { query: async () => [] };
    const orders = Array.from({ length: 200_000 }, (_, i) => ({
      id: `o${i}`,
      createdAt: 1_700_000_000_000 + i,
      visitorId: null,
      emailHash: null,
      customerKey: null,
      landingUrl: null,
      referrer: null,
    }));
    const journeys = await attachJourneys(emptyDb, site, orders as any, 30);
    expect(journeys.size).toBe(200_000);
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Kostenimport', () => {
  const today = () => zonedDay(Date.now(), site.timezone);

  it('speichert die Währung der Kosten', async () => {
    const day = today();
    const fetchFn = (async () =>
      json({ data: [{ date_start: day, campaign_id: 'c', adset_id: 's', ad_id: 'a', spend: '1.5', impressions: '10', account_currency: 'EUR' }] })) as unknown as typeof fetch;
    expect(await syncCosts(db(), site, 'meta', { from: day, to: day, fetchFn })).toMatchObject({ rows: 1 });
    const [cost] = await db().query(`select currency from costs where site_id = $1 and platform = 'meta' and date = $2`, [site.id, day]);
    expect(cost.currency).toBe('EUR');
  });

  it('holt bei Pinterest nur die letzten 90 Tage und lässt ältere Kosten stehen', async () => {
    await saveIntegration(db(), site.id, 'pinterest', { values: { ad_account_id: '77', access_token: 'pina_GEHEIM_1234567890' } });
    const older = addDays(today(), -150);
    await db().query(`insert into costs (site_id, date, platform, channel, campaign_id, spend) values ($1, $2, 'pinterest', 'pinterest', 'alt', 5)`, [
      site.id,
      older,
    ]);
    const startDates: string[] = [];
    const fetchFn = (async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/ads/analytics')) {
        startDates.push(url.searchParams.get('start_date')!);
        return json([{ AD_ID: 'a1', DATE: url.searchParams.get('end_date'), SPEND_IN_MICRO_DOLLAR: 2_000_000, IMPRESSION_1: 10, CLICKTHROUGH_1: 1 }]);
      }
      return json({ items: url.pathname.endsWith('/ads') ? [{ id: 'a1', campaign_id: 'c1', ad_group_id: 'g1' }] : [], bookmark: null });
    }) as unknown as typeof fetch;
    const result = await syncCosts(db(), site, 'pinterest', { from: addDays(today(), -200), to: today(), fetchFn });
    expect(result.error).toBeUndefined();
    const earliest = addDays(zonedDay(Date.now(), 'UTC'), -90);
    expect(result.from! >= earliest).toBe(true);
    expect(startDates.length).toBeGreaterThan(0);
    expect(startDates.every((start) => start >= earliest)).toBe(true);
    const [kept] = await db().query(`select spend::float8 as spend from costs where site_id = $1 and platform = 'pinterest' and date = $2`, [site.id, older]);
    expect(kept?.spend).toBe(5);
  });

  it('schreibt keine Zugangsdaten aus Fehlermeldungen der Plattform in Logs und Dashboard', async () => {
    const fetchFn = (async () => json({ code: 2, message: 'Authentication failed for token pina_GEHEIM_1234567890' }, 401)) as unknown as typeof fetch;
    const result = await syncCosts(db(), site, 'pinterest', { fetchFn });
    expect(result.error).toContain('Authentication failed');
    expect(result.error).not.toContain('pina_GEHEIM');
    const [integration] = await db().query(`select last_error from integrations where site_id = $1 and platform = 'pinterest'`, [site.id]);
    expect(integration.last_error).not.toContain('pina_GEHEIM');
    expect(redactSecrets('meta', { access_token: 'EAAgeheim123456' }, 'Malformed access token EAAgeheim123456')).toBe('Malformed access token ***');
  });
});
