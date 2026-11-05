import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, createWorkspace } from '../src/api/auth.js';
import { createApp } from '../src/app.js';
import { closeDb, db, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { normalizeCurrency, normalizePhone, truncateIp } from '../src/lib/normalize.js';
import { isDay, zonedDay, zonedStartOfDay } from '../src/lib/time.js';
import { anonymousUrl, scrubUrl } from '../src/lib/urls.js';
import { createSite, type Site } from '../src/sites.js';
import { htmlSnippet } from '../src/snippets.js';
import { classify } from '../src/tracking/classify.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ORIGIN = 'https://haertung.de';
let app: ReturnType<typeof createApp>;
let site: Site;
let secretKey: string;
let cookie = '';

beforeAll(async () => {
  await openDb(process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL } : { dir: 'memory' });
  await migrate(db());
  const workspaceId = await createWorkspace(db(), 'Härtung');
  await createUser(db(), { email: 'haertung@test.de', password: 'sehr-geheim-123', workspaceId });
  ({ site, secretKey } = await createSite(db(), { workspaceId, name: 'Härtung', platform: 'woocommerce', domains: ['haertung.de'] }));
  app = createApp();
  const login = await app.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'haertung@test.de', password: 'sehr-geheim-123' }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

afterAll(async () => {
  await closeDb();
});

const ev = (n: string, p: Record<string, unknown> = {}) => ({ n, id: crypto.randomUUID(), t: Date.now(), u: `${ORIGIN}/`, r: null, p });

function collect(body: Record<string, unknown>) {
  return app.request('/v1/collect', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'user-agent': UA, origin: ORIGIN },
    body: JSON.stringify({ k: site.publicKey, c: 1, ...body }),
  });
}

function apiOrder(body: unknown) {
  return app.request('/v1/orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dashboard(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' };
  if (init.method && init.method !== 'GET') headers['x-bezzify'] = '1';
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return app.request(`/api${path}`, { method: init.method ?? 'GET', headers, body });
}

const orderCurrency = async (externalId: string) =>
  (await db().query('select currency from orders where site_id = $1 and external_id = $2', [site.id, externalId]))[0]?.currency;

describe('Normalisierung und Zeit', () => {
  it('kürzt auch komprimierte IPv6 Adressen auf /48', () => {
    expect(truncateIp('2001:db8::1')).toBe('2001:db8:0::');
    expect(truncateIp('fe80::1:2:3:4')).toBe('fe80:0:0::');
    expect(truncateIp('::1')).toBe('0:0:0::');
    expect(truncateIp('kein:ip')).toBeNull();
  });

  it('lässt die Null in Klammern nach der Ländervorwahl weg', () => {
    expect(normalizePhone('+49 (0) 171 1234567')).toBe('491711234567');
    expect(normalizePhone('0049 (0)171 1234567')).toBe('491711234567');
    expect(normalizePhone('(0)171 1234567')).toBe('491711234567');
  });

  it('nimmt nur Währungscodes aus drei Buchstaben', () => {
    expect(normalizeCurrency(' usd ')).toBe('USD');
    expect(['EU', 'EURO', '€€€', '12 ', 42, null].map(normalizeCurrency)).toEqual([null, null, null, null, null, null]);
  });

  it('erkennt ungültige Kalendertage', () => {
    expect(['2026-02-28', '2028-02-29', '2026-02-29', '2026-02-30', '2026-04-31'].map(isDay)).toEqual([true, true, false, false, false]);
  });

  it('findet den Tagesbeginn, wenn die Sommerzeit um Mitternacht beginnt', () => {
    for (const [tz, day, start] of [
      ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z'],
      ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z'],
      ['America/Santiago', '2026-04-05', '2026-04-05T04:00:00.000Z'],
    ]) {
      const ts = zonedStartOfDay(day, tz);
      expect(ts.toISOString()).toBe(start);
      expect(zonedDay(ts, tz)).toBe(day);
      expect(zonedDay(ts.getTime() - 1, tz)).not.toBe(day);
    }
  });

  it('entfernt Zugangsdaten vor dem Host aus URLs', () => {
    expect(scrubUrl('https://kunde:geheim@haertung.de/konto?utm_source=x')).toBe('https://haertung.de/konto?utm_source=x');
    expect(anonymousUrl('https://kunde:geheim@haertung.de/?utm_source=x&gclid=1')).toBe('https://haertung.de/?utm_source=x');
  });
});

describe('Quellen', () => {
  const opts = { siteHosts: ['haertung.de'] };
  const channel = (referrer: string) => classify(`${ORIGIN}/danke`, referrer, opts).channel;

  it('wertet die Suche von WEB.DE und GMX als organische Suche, deren Postfach als Mail', () => {
    expect(channel('https://suche.web.de/web?q=arduino')).toBe('organic_search');
    expect(channel('https://suche.gmx.net/web?q=arduino')).toBe('organic_search');
    expect(channel('https://web.de/')).toBe('email');
    expect(channel('https://mail.google.com/mail/u/0')).toBe('email');
  });

  it('wertet Rücksprünge von Zahlungsanbietern als intern', () => {
    const payments = [
      'https://www.giropay.de/',
      'https://pay.amazon.de/',
      'https://www.computop-paygate.com/',
      'https://centinelapi.cardinalcommerce.com/',
    ];
    for (const referrer of payments) expect(channel(referrer)).toBe('internal');
    expect(channel('https://flowerordering.de/')).toBe('referral');
  });

  it('maskiert Werte im HTML Snippet', () => {
    const hostile = { ...site, settings: { ...site.settings, cookieDomain: 'x" onload="alert(1)' } };
    const snippet = htmlSnippet(hostile, 'https://t.example.de', 'granted');
    expect(snippet).toContain('data-cookie-domain="x&quot; onload=&quot;alert(1)"');
  });
});

describe('Öffentliche Endpunkte', () => {
  it('vereinheitlicht Eventnamen und verwirft ungültige, ohne den Stapel abzulehnen', async () => {
    const events = [ev('__proto__'), ev('Neuer Kunde'), ev('page_view'), ev('newsletter_signup'), ev('Add-To-Cart'), ev('1abc')];
    expect((await collect({ v: 'visitorHAERTUNG001', e: events })).status).toBe(204);
    const names = await db().query('select name from events where visitor_id = $1 order by name', ['visitorHAERTUNG001']);
    expect(names.map((row: { name: string }) => row.name)).toEqual(['add_to_cart', 'neuer_kunde', 'newsletter_signup', 'page_view']);
  });

  it('übernimmt nur gültige Währungen und fällt sonst auf die Shopwährung zurück', async () => {
    await collect({ v: 'visitorHAERTUNG002', e: [ev('purchase', { order_id: 'CUR-1', value: 10, currency: 'eu' })] });
    await collect({ v: 'visitorHAERTUNG002', e: [ev('purchase', { order_id: 'CUR-2', value: 10, currency: 'usd' })] });
    expect(await orderCurrency('CUR-1')).toBe('EUR');
    expect(await orderCurrency('CUR-2')).toBe('USD');
    expect((await apiOrder({ order_id: 'CUR-3', total: 10, currency: '€€€' })).status).toBe(200);
    expect((await apiOrder({ order_id: 'CUR-4', total: 10, currency: 'chf' })).status).toBe(200);
    expect(await orderCurrency('CUR-3')).toBe('EUR');
    expect(await orderCurrency('CUR-4')).toBe('CHF');
  });

  it('antwortet der Server API mit 400 nur bei ungültigen Eingaben, sonst mit 413 oder 500', async () => {
    expect((await apiOrder('{kaputt')).status).toBe(400);
    expect((await apiOrder({ order_id: '  ', total: 1 })).status).toBe(400);
    expect((await apiOrder({ order_id: 'D-1', total: 1, created_at: 'gestern' })).status).toBe(400);
    expect((await apiOrder({ order_id: 'D-2', total: 1, pad: 'x'.repeat(3 * 1024 * 1024) })).status).toBe(413);
    // numeric(14,2) läuft über, ein Fehler der Datenbank, den der Shop erneut senden soll
    const overflow = await apiOrder({ order_id: 'D-3', total: 1e20 });
    expect(overflow.status).toBe(500);
    expect(await overflow.json()).toEqual({ error: 'Interner Fehler' });
    const webhook = await app.request(`/webhooks/shopify/${site.id}`, { method: 'POST', body: 'x'.repeat(6 * 1024 * 1024) });
    expect(webhook.status).toBe(413);
  });

  it('nimmt die Anmeldung nur als JSON an', async () => {
    const form = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ email: 'haertung@test.de', password: 'sehr-geheim-123' }),
    });
    expect(form.status).toBe(415);
    expect(form.headers.get('set-cookie')).toBeNull();
    const empty = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    expect(empty.status).toBe(401);
  });
});

describe('Dashboard', () => {
  it('ignoriert unbekannte Abfrageparameter statt mit 500 zu scheitern', async () => {
    const overview = await dashboard(`/report/overview?site=${site.id}&window=toString&from=2026-02-30`);
    expect(overview.status).toBe(200);
    expect((await overview.json()).windowDays).toBe(site.settings.windowDays);
    expect((await dashboard(`/journeys?site=${site.id}&limit=abc`)).status).toBe(200);
    expect((await dashboard(`/integrations/meta/sync?site=${site.id}&days=abc`, { method: 'POST' })).status).toBe(200);
  });

  it('prüft Cookie Domain und Währung beim Speichern', async () => {
    const put = (body: unknown) => dashboard(`/sites/${site.id}`, { method: 'PUT', body });
    expect((await put({ settings: { cookieDomain: 'x" onload="alert(1)' } })).status).toBe(400);
    expect((await put({ currency: 'ch' })).status).toBe(400);
    expect((await put({ settings: { cookieDomain: ' .Haertung.DE ' }, currency: 'chf' })).status).toBe(200);
    const [stored] = await db().query('select currency, settings from sites where id = $1', [site.id]);
    expect(stored.currency).toBe('CHF');
    expect(stored.settings.cookieDomain).toBe('.haertung.de');
  });
});
