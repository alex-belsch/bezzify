import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, createWorkspace } from '../src/api/auth.js';
import { createApp } from '../src/app.js';
import { attachJourneys, loadOrderById } from '../src/attribution/engine.js';
import { closeDb, db, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { decrypt, hmacSha256, sha256Hex } from '../src/lib/crypto.js';
import { hashPhoneE164, rateLimitKey } from '../src/lib/normalize.js';
import { saveIntegration } from '../src/integrations/store.js';
import { clearSiteCache, createSite, type Site } from '../src/sites.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ORIGIN = 'https://kennung.de';
let app: ReturnType<typeof createApp>;
let site: Site;
let secretKey: string;

beforeAll(async () => {
  await openDb(process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL } : { dir: 'memory' });
  await migrate(db());
  const workspaceId = await createWorkspace(db(), 'Kennung');
  await createUser(db(), { email: 'kennung@test.de', password: 'sehr-geheim-123', workspaceId });
  ({ site, secretKey } = await createSite(db(), { workspaceId, name: 'Kennung', platform: 'shopify', domains: ['kennung.de'] }));
  await saveIntegration(db(), site.id, 'shopify', { values: { webhook_secret: 'whsec_kennung' } });
  clearSiteCache();
  app = createApp();
});

afterAll(async () => {
  await closeDb();
});

const ev = (n: string, u: string, p: Record<string, unknown> = {}) => ({ n, id: crypto.randomUUID(), t: Date.now(), u, r: null, p });

function collect(body: Record<string, unknown>) {
  return app.request('/v1/collect', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'user-agent': UA, origin: ORIGIN },
    body: typeof body === 'string' ? body : JSON.stringify({ k: site.publicKey, c: 1, ...body }),
  });
}

function apiOrder(body: Record<string, unknown>) {
  return app.request('/v1/orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currency: 'EUR', ...body }),
  });
}

function shopifyWebhook(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return app.request(`/webhooks/shopify/${site.id}`, {
    method: 'POST',
    headers: { 'x-shopify-hmac-sha256': hmacSha256('whsec_kennung', raw).toString('base64'), 'x-shopify-topic': 'orders/create' },
    body: raw,
  });
}

const order = async (externalId: string) =>
  (await db().query('select * from orders where site_id = $1 and external_id = $2', [site.id, externalId]))[0];

describe('Identitäten', () => {
  it('verknüpft Kundennummern aus dem Browser nicht und zählt fremde Klicks nicht für die Rückspielung', async () => {
    // Angreifer klickt den eigenen Awin Link und gibt sich mit Mail und Kundennummer des Opfers aus
    await collect({ v: 'visitorANGREIFER01', mk: 1, e: [ev('page_view', `${ORIGIN}/?awc=1234_999_angreifer&utm_source=awin`)] });
    await collect({ v: 'visitorANGREIFER01', mk: 1, e: [ev('identify', `${ORIGIN}/konto`, { email: 'opfer@test.de', customer_id: '77' })] });
    const linked = await db().query('select kind, verified from identities where site_id = $1 and visitor_id = $2 order by kind', [
      site.id,
      'visitorANGREIFER01',
    ]);
    expect(linked).toEqual([{ kind: 'email_sha256', verified: false }]);

    await collect({ v: 'visitorOPFER000001', mk: 1, e: [ev('page_view', `${ORIGIN}/`)] });
    await apiOrder({ order_id: 'ID-1', total: 90, email: 'opfer@test.de', customer_id: '77', visitor_id: 'visitorOPFER000001', consent_marketing: true });
    const row = await order('ID-1');
    const loaded = (await loadOrderById(db(), site, row.id))!;
    const visitorsIn = (journeys: Map<string, { visitorId: string | null }[]>) => new Set((journeys.get(row.id) ?? []).map((t) => t.visitorId));

    // Auswertung: geräteübergreifend über die Mailadresse, auch unbestätigt
    expect(visitorsIn(await attachJourneys(db(), site, [loaded], 30))).toEqual(new Set(['visitorOPFER000001', 'visitorANGREIFER01']));
    // Rückspielung: nur bestätigte Verknüpfungen, der Awin Klick des Angreifers fehlt
    expect(visitorsIn(await attachJourneys(db(), site, [loaded], 30, { verifiedIdentitiesOnly: true }))).toEqual(
      new Set(['visitorOPFER000001']),
    );
    const victimLinks = await db().query('select kind, verified from identities where site_id = $1 and visitor_id = $2 order by kind', [
      site.id,
      'visitorOPFER000001',
    ]);
    expect(victimLinks).toEqual([
      { kind: 'customer', verified: true },
      { kind: 'email_sha256', verified: true },
    ]);
  });
});

describe('Merkmale nur mit Marketing Einwilligung', () => {
  it('speichert IP und User Agent aus dem Shopify Webhook erst, wenn die Einwilligung feststeht', async () => {
    const webhook = {
      id: 5501,
      created_at: new Date().toISOString(),
      total_price: '40.00',
      financial_status: 'paid',
      email: 'merkmal@test.de',
      phone: '0171 1234567',
      browser_ip: '203.0.113.50',
      client_details: { user_agent: UA },
    };
    expect((await shopifyWebhook(webhook)).status).toBe(200);
    expect(await order('5501')).toMatchObject({ consent_marketing: null, match_data: null });

    await collect({
      v: 'visitorMERKMAL0001',
      mk: 1,
      m: { fbp: 'fb.1.1.merkmal' },
      e: [ev('purchase', `${ORIGIN}/danke`, { order_id: '5501', value: 40, email: 'merkmal@test.de', phone: '0171 1234567' })],
    });
    const match = decrypt<Record<string, string>>((await order('5501')).match_data);
    expect(match).toMatchObject({ fbp: 'fb.1.1.merkmal', phE164: sha256Hex('+491711234567') });
    expect((await order('5501')).consent_marketing).toBe(true);
  });

  it('verwirft Merkmale, wenn der Shop keine Einwilligung meldet', async () => {
    await apiOrder({ order_id: 'NOMK-1', total: 10, ip: '203.0.113.9', user_agent: UA, consent_marketing: false });
    expect((await order('NOMK-1')).match_data).toBeNull();
    await apiOrder({ order_id: 'MK-1', total: 10, ip: '203.0.113.9', user_agent: UA, consent_marketing: true });
    expect(decrypt<Record<string, string>>((await order('MK-1')).match_data)?.ip).toBe('203.0.113.9');
    // nachträglich widerrufen
    await apiOrder({ order_id: 'MK-1', total: 10, consent_marketing: false });
    expect(await order('MK-1')).toMatchObject({ match_data: null, match_data_at: null });
  });
});

describe('Eingaben', () => {
  it('entfernt Nullzeichen, statt den ganzen Stapel scheitern zu lassen', async () => {
    const body = JSON.stringify({
      k: site.publicKey,
      c: 1,
      v: 'visitorNULLZEICHEN',
      e: [ev('page_view', `${ORIGIN}/?utm_source=a\u0000b`, { 'schl\u0000ssel': 'we\u0000rt' })],
    });
    expect((await collect(body as unknown as Record<string, unknown>)).status).toBe(204);
    const [event] = await db().query('select props from events where visitor_id = $1', ['visitorNULLZEICHEN']);
    expect(event.props).toEqual({ schlssel: 'wert' });
  });

  it('nimmt Bestellungen mit überlangen Nebenfeldern an, statt sie zu verwerfen', async () => {
    const items = Array.from({ length: 600 }, (_, index) => ({ sku: `S${index}`, name: 'x'.repeat(300), quantity: 1, price: 1 }));
    const response = await apiOrder({
      order_id: 'LANG-1',
      total: 600,
      user_agent: 'U'.repeat(2000),
      phone: '1'.repeat(100),
      landing_url: `${ORIGIN}/?q=${'a'.repeat(5000)}`,
      items,
      consent_marketing: true,
    });
    expect(response.status).toBe(200);
    const row = await order('LANG-1');
    expect(row.phone_sha256).toBeNull();
    expect(row.items).toHaveLength(500);
    expect(row.items[0].name).toHaveLength(200);
    expect(decrypt<Record<string, string>>(row.match_data)?.ua).toHaveLength(1024);
  });

  it('fasst IPv6 Adressen für Rate Limits je /64 zusammen', () => {
    expect(rateLimitKey('2001:db8:1:2:a:b:c:d')).toBe(rateLimitKey('2001:db8:1:2::ffff'));
    expect(rateLimitKey('2001:db8:1:3::1')).not.toBe(rateLimitKey('2001:db8:1:2::1'));
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey(null)).toBe('unknown');
  });

  it('hasht Telefonnummern für TikTok mit Pluszeichen', () => {
    expect(hashPhoneE164('+49 171 1234567')).toBe(sha256Hex('+491711234567'));
    expect(hashPhoneE164(sha256Hex('491711234567'))).toBeNull();
  });
});

describe('Abmelden', () => {
  it('entwertet die Sitzung auch dann, wenn jemand das alte Cookie aufbewahrt', async () => {
    const login = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'kennung@test.de', password: 'sehr-geheim-123' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200);
    expect((await app.request('/api/logout', { method: 'POST', headers: { cookie } })).status).toBe(403);
    expect((await app.request('/api/logout', { method: 'POST', headers: { cookie, 'x-bezzify': '1' } })).status).toBe(200);
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(401);
  });
});
