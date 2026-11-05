import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { parseJsonBody } from '../lib/http.js';
import { errMsg, log } from '../lib/log.js';
import { normalizeExternalId, rateLimitKey } from '../lib/normalize.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { hostOf } from '../lib/urls.js';
import { cancelApiOrder, ingestApiOrder, ingestApiRefund } from '../orders/api.js';
import { handleShopifyWebhook, verifyShopifyHmac } from '../orders/shopify.js';
import { getIntegration } from '../integrations/store.js';
import { getSiteById, getSiteByPublicKey, getSiteBySecret, type Site } from '../sites.js';
import { PublicAnswerSchema, ServerAnswerSchema, publicSurvey, saveSurveyAnswer } from '../survey.js';
import { isBot } from '../tracking/bots.js';
import { isOwnHost } from '../tracking/classify.js';
import { CollectSchema, processCollect, type CollectPayload } from '../tracking/collect.js';
import { HttpStatusError, readJson } from './auth.js';

// je Besucher eng, je IP großzügig, weil sich hinter Firmen NAT viele Besucher eine IP teilen
const visitorLimiter = new RateLimiter(240, 60_000);
const ipLimiter = new RateLimiter(20_000, 60_000);
const apiLimiter = new RateLimiter(600, 60_000);
const surveyLimiter = new RateLimiter(30, 60_000);
let proxyWarned = false;

function cleanIp(ip: string): string {
  let address = ip.trim().replace(/^\[|\](?::\d+)?$/g, '');
  const v4WithPort = address.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (v4WithPort) address = v4WithPort[1];
  return address.replace(/^::ffff:/i, '');
}

/**
 * Jeder Proxy hängt die Adresse seines Gegenübers rechts an X-Forwarded-For an,
 * nur die rechten TRUST_PROXY Einträge stammen von eigenen Proxys.
 */
export function clientIp(c: Context): string | null {
  if (config.trustProxy > 0) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const hops = xff
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean);
      const ip = hops[hops.length - config.trustProxy] ?? hops[0];
      if (ip) return cleanIp(ip);
    }
    const real = c.req.header('x-real-ip');
    if (real) return cleanIp(real);
  } else if (!proxyWarned && c.req.header('x-forwarded-for')) {
    proxyWarned = true;
    log.warn('X-Forwarded-For kommt an, TRUST_PROXY ist aber aus. Hinter einem Reverse Proxy TRUST_PROXY=1 setzen, sonst teilen sich alle Besucher eine IP.');
  }
  const address = socketAddress(c);
  return address ? cleanIp(address) : null;
}

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // ohne Node Socket, etwa bei app.request in Tests
    return undefined;
  }
}

let trackerCache: { body: string; at: number } | null = null;
function trackerSource(): string {
  if (trackerCache && (config.isProd || Date.now() - trackerCache.at < 2000)) return trackerCache.body;
  const built = join(process.cwd(), 'dist/tracker/t.js');
  const source = join(process.cwd(), 'tracker/t.js');
  const body = readFileSync(existsSync(built) ? built : source, 'utf8');
  trackerCache = { body, at: Date.now() };
  return body;
}

export function originAllowed(site: Site, origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return site.settings.allowNullOrigin;
  const host = hostOf(origin);
  if (!host) return false;
  if (!config.isProd && (host === 'localhost' || host === '127.0.0.1')) return true;
  if (!site.domains.length) return true;
  return isOwnHost(host, site.domains);
}

function corsHeaders(c: Context, origin: string | undefined) {
  if (!origin) return;
  if (origin === 'null') {
    c.header('Access-Control-Allow-Origin', '*');
  } else {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
}

function bearer(c: Context): string | null {
  const match = (c.req.header('authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

export function publicRoutes() {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/t.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(trackerSource());
  });

  app.options('/v1/collect', (c) => {
    corsHeaders(c, c.req.header('origin'));
    c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Max-Age', '86400');
    return c.body(null, 204);
  });

  app.post('/v1/collect', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    const origin = c.req.header('origin');
    const ip = clientIp(c);
    const ua = c.req.header('user-agent') ?? null;
    if (!ipLimiter.allow(rateLimitKey(ip))) return c.body(null, 429);
    let payload: CollectPayload;
    try {
      payload = CollectSchema.parse(parseJsonBody(await c.req.text()));
    } catch {
      corsHeaders(c, origin);
      return c.body(null, 400);
    }
    if (!visitorLimiter.allow(`${rateLimitKey(ip)}|${payload.v ?? ''}`)) return c.body(null, 429);
    const site = await getSiteByPublicKey(db(), payload.k);
    if (!site) return c.body(null, 404);
    if (!originAllowed(site, origin)) return c.body(null, 403);
    corsHeaders(c, origin);
    if (isBot(ua)) return c.body(null, 204);
    try {
      const collected = await db().tx((tx) => processCollect(tx, site, payload, { ip, ua, now: Date.now() }));
      // Der Server setzt das Besuchercookie erneut, so lebt es in Safari länger als per JavaScript gesetzt
      const cookieDomain = site.settings.cookieDomain?.replace(/^\./, '');
      const host = origin && origin !== 'null' ? hostOf(origin) : null;
      if (collected.visitorId && cookieDomain && host && (host === cookieDomain || host.endsWith('.' + cookieDomain))) {
        const attrs = `Domain=.${cookieDomain}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`;
        c.header('Set-Cookie', `_bzf_id=${collected.visitorId}; ${attrs}`, { append: true });
        c.header('Set-Cookie', `_bzf_c=${collected.marketing ? 2 : 1}; ${attrs}`, { append: true });
      }
      return c.body(null, 204);
    } catch (e) {
      log.error('collect fehlgeschlagen', { site: site.id, err: errMsg(e) });
      return c.body(null, 500);
    }
  });

  // Ungültige Eingaben beantwortet der zentrale Fehlerhandler mit 400, alles andere mit 500, damit die Shops es erneut senden
  const serverApi = new Hono<{ Variables: { site: Site } }>();
  serverApi.use('*', async (c, next) => {
    const secret = bearer(c);
    const site = secret ? await getSiteBySecret(db(), secret) : null;
    if (!site) return c.json({ error: 'Secret Key ungültig' }, 401);
    if (!apiLimiter.allow(site.id)) return c.json({ error: 'Zu viele Anfragen' }, 429);
    c.set('site', site);
    await next();
  });
  serverApi.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  serverApi.post('/orders', async (c) => {
    const body = await readJson(c);
    const upserted = await db().tx((tx) => ingestApiOrder(tx, c.get('site'), body));
    return c.json({ ok: true, ...upserted });
  });
  serverApi.post('/refunds', async (c) => {
    const body = await readJson(c);
    await db().tx((tx) => ingestApiRefund(tx, c.get('site'), body));
    return c.json({ ok: true });
  });
  serverApi.post('/orders/:orderId/cancel', async (c) => {
    await cancelApiOrder(db(), c.get('site'), c.req.param('orderId'));
    return c.json({ ok: true });
  });
  serverApi.post('/orders/:orderId/survey', async (c) => {
    const orderId = normalizeExternalId(c.req.param('orderId'));
    if (!orderId) throw new HttpStatusError(400, 'Bestell ID fehlt');
    const { answer } = ServerAnswerSchema.parse(await readJson(c));
    const saved = await saveSurveyAnswer(db(), c.get('site'), `order:${orderId}`, answer);
    if (saved === 'unknown_answer') throw new HttpStatusError(400, 'Diese Antwort gibt es in der Umfrage nicht');
    return c.json({ ok: true, duplicate: saved === 'duplicate' });
  });

  // Die Erweiterung der Shopify Danke Seite läuft in einem Web Worker ohne festen Origin, Shopify verlangt deshalb CORS für alle
  app.options('/v1/survey', (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Max-Age', '86400');
    return c.body(null, 204);
  });

  app.get('/v1/survey', async (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    const site = await getSiteByPublicKey(db(), c.req.query('k') ?? '');
    if (!site) return c.json({ error: 'Unbekannter Site Key' }, 404);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(publicSurvey(site));
  });

  // Nachweis ist der Checkout Token, den nur der Käufer kennt. Erst mit der Bestellung aus dem Webhook zählt die Antwort.
  app.post('/v1/survey', bodyLimit({ maxSize: 4096, onError: (c) => c.body(null, 413) }), async (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    if (!surveyLimiter.allow(rateLimitKey(clientIp(c)))) return c.body(null, 429);
    let body: { k: string; checkout_token: string; answer: string };
    try {
      body = PublicAnswerSchema.parse(parseJsonBody(await c.req.text()));
    } catch {
      return c.body(null, 400);
    }
    const site = await getSiteByPublicKey(db(), body.k);
    if (!site?.settings.survey.enabled) return c.body(null, 404);
    const saved = await saveSurveyAnswer(db(), site, `checkout:${body.checkout_token}`, body.answer);
    return c.body(null, saved === 'unknown_answer' ? 400 : 204);
  });

  app.route('/v1', serverApi);

  app.post('/webhooks/shopify/:siteId', bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
    const site = await getSiteById(db(), c.req.param('siteId'));
    if (!site) return c.body(null, 404);
    const integration = await getIntegration(db(), site.id, 'shopify');
    const secret = integration?.values.webhook_secret;
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!secret || !verifyShopifyHmac(raw, c.req.header('x-shopify-hmac-sha256'), secret)) {
      log.warn('Shopify Webhook mit ungültiger Signatur', { site: site.id });
      return c.body(null, 401);
    }
    const topic = c.req.header('x-shopify-topic') ?? '';
    try {
      const body = parseJsonBody(raw.toString('utf8'));
      const kind = await db().tx((tx) => handleShopifyWebhook(tx, site, topic, body));
      return c.json({ ok: true, kind });
    } catch (e) {
      log.error('Shopify Webhook fehlgeschlagen', { site: site.id, topic, err: errMsg(e) });
      return c.json({ error: 'Verarbeitung fehlgeschlagen' }, 500);
    }
  });

  return app;
}
