import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { randomId, verifyToken } from '../lib/crypto.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { addDays, isDay, isTimeZone, zonedDay } from '../lib/time.js';
import { parseUrl } from '../lib/urls.js';
import { MODEL_LABELS, MODELS, isModel } from '../attribution/models.js';
import { breakdown, journeys, modelComparison, overview, type ReportParams } from '../attribution/report.js';
import { PLATFORMS, platformDef } from '../integrations/registry.js';
import { listIntegrations, maskValues, saveIntegration } from '../integrations/store.js';
import { COST_FETCHERS, syncCosts } from '../integrations/sync.js';
import { clearSiteCache, createSite, defaultSettings, listSitesForWorkspaces, normalizeDomains, rotateSecret, type Site } from '../sites.js';
import { URL_TEMPLATES, consentSnippet, htmlSnippet, shopifyPixel } from '../snippets.js';
import { SURVEY_CHANNELS, SurveySchema, surveyStats } from '../survey.js';
import { CHANNEL_LABELS } from '../tracking/classify.js';
import { HttpStatusError, SESSION_COOKIE, SESSION_TTL, login, readJson, requireAuth, requireSite, revokeSessions, type AppEnv } from './auth.js';
import { clientIp } from './public.js';

// je IP alle Versuche, je Mailadresse die Fehlversuche, das schützt auch bei vielen IPs
const loginLimiter = new RateLimiter(10, 15 * 60_000);
const loginFailLimiter = new RateLimiter(10, 15 * 60_000);

// Kurzer Cache, damit Seitenwechsel im Dashboard nicht alles neu rechnen
const reportCache = new Map<string, { at: number; value: Promise<unknown> }>();
const REPORT_TTL_MS = 30_000;
const REPORT_MAX_ENTRIES = 100;

function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = reportCache.get(key);
  if (hit && now - hit.at < REPORT_TTL_MS) return hit.value as Promise<T>;
  for (const [entryKey, entry] of reportCache) if (now - entry.at >= REPORT_TTL_MS) reportCache.delete(entryKey);
  while (reportCache.size >= REPORT_MAX_ENTRIES) reportCache.delete(reportCache.keys().next().value as string);
  const value = compute();
  reportCache.set(key, { at: now, value });
  void value.catch(() => {
    if (reportCache.get(key)?.value === value) reportCache.delete(key);
  });
  return value;
}

const WINDOWS: Record<string, number | null> = { '1': 1, '7': 7, '14': 14, '30': 30, '60': 60, '90': 90, unlimited: null };

function intQuery(c: Context, name: string, fallback: number, min: number, max: number): number {
  const value = Number(c.req.query(name) ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

export function reportParams(c: Context, site: Site): ReportParams {
  const today = zonedDay(Date.now(), site.timezone);
  const toParam = c.req.query('to');
  const fromParam = c.req.query('from');
  const to = isDay(toParam) ? toParam : today;
  const from = isDay(fromParam) ? fromParam : addDays(to, -29);
  if (from > to) throw new HttpStatusError(400, 'from liegt nach to');
  if (addDays(from, 731) < to) throw new HttpStatusError(400, 'Zeitraum höchstens zwei Jahre');
  const model = c.req.query('model');
  const windowParam = c.req.query('window');
  const ignoreDirect = c.req.query('ignoreDirect');
  return {
    from,
    to,
    model: isModel(model) ? model : site.settings.attributionModel,
    windowDays: windowParam !== undefined && Object.hasOwn(WINDOWS, windowParam) ? WINDOWS[windowParam] : site.settings.windowDays,
    ignoreDirect: ignoreDirect === undefined ? site.settings.ignoreDirect : ignoreDirect === '1',
    basis: c.req.query('basis') === 'touch' ? 'touch' : 'conversion',
    extrapolate: c.req.query('extrapolate') === '1',
  };
}

const PlatformSchema = z.enum(['shopify', 'shopware', 'woocommerce', 'custom']);
const DomainsSchema = z.array(z.string().max(253)).max(20);
const COOKIE_DOMAIN_RE = /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

const SettingsSchema = z
  .object({
    attributionModel: z.enum(MODELS as [string, ...string[]]),
    windowDays: z.number().int().min(1).max(365).nullable(),
    ignoreDirect: z.boolean(),
    revenueBasis: z.enum(['gross', 'net']),
    subtractRefunds: z.boolean(),
    consentRequiredForFeedback: z.boolean(),
    clickIdWithoutParams: z.enum(['paid', 'organic']),
    cookieDomain: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .refine(
        (domain) => domain === '' || (domain.length <= 253 && COOKIE_DOMAIN_RE.test(domain)),
        'Keine gültige Domain, z.B. .deinshop.de',
      )
      .nullable(),
    allowNullOrigin: z.boolean(),
    feedbackDelayMinutes: z.number().int().min(0).max(1440),
    awinDedup: z.enum(['last_paid_click', 'always_aw']),
    defaultCountryCode: z.string().regex(/^\d{1,3}$/),
    timeDecayHalfLifeDays: z.number().min(0.5).max(90),
    survey: SurveySchema,
  })
  .partial();

const SiteCreateSchema = z.object({
  workspaceId: z.string(),
  name: z.string().min(1).max(120),
  platform: PlatformSchema,
  domains: DomainsSchema,
});

const SiteUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  platform: PlatformSchema.optional(),
  domains: DomainsSchema.optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'Dreistelliger Währungscode, z.B. EUR')
    .transform((code) => code.toUpperCase())
    .optional(),
  timezone: z.string().max(64).refine(isTimeZone, 'Unbekannte Zeitzone, z.B. Europe/Berlin').optional(),
  settings: SettingsSchema.optional(),
});

const IntegrationSchema = z.object({
  enabled: z.boolean().optional(),
  values: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

const ManualCostSchema = z.object({
  channel: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  amount: z.number().nonnegative(),
  from: z.string().refine(isDay),
  to: z.string().refine(isDay),
});

function siteOut(site: Site) {
  return {
    id: site.id,
    workspaceId: site.workspaceId,
    name: site.name,
    platform: site.platform,
    domains: site.domains,
    currency: site.currency,
    timezone: site.timezone,
    publicKey: site.publicKey,
    settings: site.settings,
  };
}

function pathOf(url: string | null): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  return parsed.pathname + (parsed.search.length > 1 ? parsed.search.slice(0, 80) : '');
}

interface LiveEventRow {
  name: string;
  ts: Date;
  url: string | null;
  visitor_id: string | null;
  channel: string | null;
  source: string | null;
  campaign: string | null;
  device: string | null;
}

export function dashboardRoutes() {
  const app = new Hono<AppEnv>();

  app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));

  app.post('/login', async (c) => {
    const ip = clientIp(c) ?? 'unknown';
    if (!loginLimiter.allow(ip)) return c.json({ error: 'Zu viele Versuche, bitte später erneut' }, 429);
    // Ein fremdes Formular kann kein JSON senden und den Browser so nicht in ein anderes Konto einloggen
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'Anmeldung erwartet JSON' }, 415);
    }
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const email = String(body?.email ?? '').trim().toLowerCase().slice(0, 254);
    if (loginFailLimiter.blocked(email)) return c.json({ error: 'Zu viele Versuche, bitte später erneut' }, 429);
    const session = await login(db(), email, String(body?.password ?? ''));
    if (!session) {
      loginFailLimiter.allow(email);
      return c.json({ error: 'Mail oder Passwort falsch' }, 401);
    }
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: config.publicUrl.startsWith('https://'),
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL,
    });
    return c.json({ ok: true });
  });

  app.post('/logout', async (c) => {
    if (c.req.header('x-bezzify') !== '1') return c.json({ error: 'Header x-bezzify fehlt' }, 403);
    const token = verifyToken<{ uid: string }>(getCookie(c, SESSION_COOKIE));
    if (token) await revokeSessions(db(), token.uid);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.use('*', requireAuth);

  app.get('/me', async (c) => {
    const user = c.get('user');
    const workspaces = await db().query('select id, name from workspaces where id = any($1) order by created_at', [user.workspaceIds]);
    const sites = await listSitesForWorkspaces(db(), user.workspaceIds);
    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      workspaces,
      sites: sites.map(siteOut),
      models: MODELS.map((id) => ({ id, label: MODEL_LABELS[id] })),
      channels: CHANNEL_LABELS,
      endpoint: config.publicUrl,
    });
  });

  app.get('/report/overview', async (c) => {
    const site = await requireSite(c);
    const params = reportParams(c, site);
    return c.json(await cached(`ov|${site.id}|${JSON.stringify(params)}`, () => overview(db(), site, params)));
  });

  app.get('/report/breakdown', async (c) => {
    const site = await requireSite(c);
    const params = reportParams(c, site);
    const channel = c.req.query('channel') || null;
    // nur die Antwort cachen, nicht die Journey Daten aus dem Ergebnis
    const response = await cached(`br|${site.id}|${channel}|${JSON.stringify(params)}`, async () => {
      const report = await breakdown(db(), site, params, { channel, maxDepth: channel ? 3 : 1 });
      return {
        range: { from: params.from, to: params.to },
        currency: site.currency,
        rows: report.rows,
        totals: report.totals,
        unattributed: report.unattributed,
        extrapolated: report.extrapolated,
        extrapolation: report.extrapolation,
      };
    });
    return c.json(response);
  });

  app.get('/report/models', async (c) => {
    const site = await requireSite(c);
    const params = reportParams(c, site);
    return c.json(await cached(`mc|${site.id}|${JSON.stringify(params)}`, () => modelComparison(db(), site, params)));
  });

  app.get('/journeys', async (c) => {
    const site = await requireSite(c);
    const limit = intQuery(c, 'limit', 50, 1, 200);
    return c.json(await journeys(db(), site, reportParams(c, site), { limit, channel: c.req.query('channel') || null }));
  });

  app.get('/live', async (c) => {
    const site = await requireSite(c);
    const q = db();
    const events = await q.query<LiveEventRow>(
      `select e.name, e.ts, e.url, e.visitor_id, s.channel, s.source, s.campaign, s.device
       from events e left join sessions s on s.id = e.session_id
       where e.site_id = $1 order by e.ts desc limit 60`,
      [site.id],
    );
    const active = await q.query<{ n: number }>(
      `select count(distinct visitor_id)::int as n from events where site_id = $1 and ts > now() - interval '5 minutes'`,
      [site.id],
    );
    const perMinute = await q.query(
      `select date_trunc('minute', ts) as minute, count(*)::int as n from events
       where site_id = $1 and ts > now() - interval '30 minutes' group by 1 order by 1`,
      [site.id],
    );
    const orders = await q.query(
      `select external_id, order_number, created_at, total::float8 as total, currency, source, visitor_id is not null as linked, is_test
       from orders where site_id = $1 order by created_at desc limit 10`,
      [site.id],
    );
    return c.json({
      active: active[0]?.n ?? 0,
      perMinute,
      events: events.map((event) => ({
        name: event.name,
        ts: event.ts,
        path: pathOf(event.url),
        visitor: event.visitor_id ? String(event.visitor_id).slice(0, 6) : null,
        channel: event.channel,
        label: CHANNEL_LABELS[event.channel ?? ''] ?? event.channel,
        source: event.source,
        campaign: event.campaign,
        device: event.device,
      })),
      orders,
    });
  });

  app.get('/diagnostics', async (c) => {
    const site = await requireSite(c);
    const q = db();
    const [events] = await q.query(
      `select count(*)::int as events_24h, max(ts) as last_event from events where site_id = $1 and ts > now() - interval '24 hours'`,
      [site.id],
    );
    const [sessions] = await q.query(
      `select count(*) filter (where visitor_id is not null)::int as identified, count(*) filter (where visitor_id is null)::int as anonymous
       from sessions where site_id = $1 and started_at > now() - interval '24 hours'`,
      [site.id],
    );
    const [orders] = await q.query(
      `select count(*)::int as total, count(*) filter (where visitor_id is not null)::int as with_visitor,
         count(*) filter (where source = 'pixel')::int as pixel_only, count(*) filter (where consent_marketing)::int as with_consent
       from orders where site_id = $1 and created_at > now() - interval '7 days' and not is_test`,
      [site.id],
    );
    const paidParams = await q.query<{ channel: string; total: number; missing: number }>(
      `select channel, count(*)::int as total, count(*) filter (where ext_campaign_id is null and ext_ad_id is null)::int as missing
       from sessions where site_id = $1 and is_paid and started_at > now() - interval '7 days' group by channel order by total desc`,
      [site.id],
    );
    const outbox = await q.query(
      `select target, status, count(*)::int as n, max(last_error) as last_error from outbox
       where site_id = $1 and created_at > now() - interval '30 days' group by target, status order by target`,
      [site.id],
    );
    return c.json({
      events24h: events?.events_24h ?? 0,
      lastEvent: events?.last_event ?? null,
      sessions24h: sessions,
      orders7d: orders,
      paidParams: paidParams.map((row) => ({ ...row, label: CHANNEL_LABELS[row.channel] ?? row.channel })),
      outbox,
    });
  });

  app.get('/setup', async (c) => {
    const site = await requireSite(c);
    const integrations = await listIntegrations(db(), site.id);
    const endpoint = config.publicUrl;
    return c.json({
      site: siteOut(site),
      endpoint,
      defaults: defaultSettings,
      webhookUrl: `${endpoint}/webhooks/shopify/${site.id}`,
      ordersApi: `${endpoint}/v1/orders`,
      snippets: {
        html: htmlSnippet(site, endpoint, 'required'),
        htmlGranted: htmlSnippet(site, endpoint, 'granted'),
        consent: consentSnippet(),
        shopifyPixel: shopifyPixel(site, endpoint),
      },
      urlTemplates: URL_TEMPLATES,
      survey: {
        endpoint: `${endpoint}/v1/survey`,
        serverApi: `${endpoint}/v1/orders/<Bestell ID>/survey`,
        channels: SURVEY_CHANNELS.map((id) => ({ id, label: CHANNEL_LABELS[id] })),
        stats: await surveyStats(db(), site),
      },
      platforms: PLATFORMS.map((platform) => {
        const integration = integrations.find((i) => i.platform === platform.id);
        return {
          ...platform,
          configured: !!integration,
          enabled: integration?.enabled ?? false,
          values: maskValues(platform.id, integration?.values ?? {}),
          lastSyncAt: integration?.lastSyncAt ?? null,
          lastError: integration?.lastError ?? null,
        };
      }),
    });
  });

  app.post('/sites', async (c) => {
    const user = c.get('user');
    const body = SiteCreateSchema.parse(await readJson(c));
    if (!user.workspaceIds.includes(body.workspaceId)) throw new HttpStatusError(403, 'Kein Zugriff auf den Workspace');
    const { site, secretKey } = await createSite(db(), body);
    return c.json({ site: siteOut(site), secretKey });
  });

  app.put('/sites/:id', async (c) => {
    const site = await requireSite(c, c.req.param('id'));
    const body = SiteUpdateSchema.parse(await readJson(c));
    const settings = { ...site.settings, ...body.settings };
    if (settings.cookieDomain === '') settings.cookieDomain = null;
    await db().query(
      `update sites set name = $2, platform = $3, domains = $4, currency = $5, timezone = $6, settings = $7 where id = $1`,
      [
        site.id,
        body.name ?? site.name,
        body.platform ?? site.platform,
        body.domains ? normalizeDomains(body.domains) : site.domains,
        (body.currency ?? site.currency).toUpperCase(),
        body.timezone ?? site.timezone,
        JSON.stringify(settings),
      ],
    );
    clearSiteCache();
    reportCache.clear();
    return c.json({ ok: true });
  });

  app.post('/sites/:id/rotate-secret', async (c) => {
    const site = await requireSite(c, c.req.param('id'));
    return c.json({ secretKey: await rotateSecret(db(), site.id) });
  });

  app.put('/integrations/:platform', async (c) => {
    const site = await requireSite(c);
    const platform = c.req.param('platform');
    if (!platformDef(platform)) throw new HttpStatusError(404, 'Unbekannte Plattform');
    await saveIntegration(db(), site.id, platform, IntegrationSchema.parse(await readJson(c)));
    return c.json({ ok: true });
  });

  app.post('/integrations/:platform/sync', async (c) => {
    const site = await requireSite(c);
    const platform = c.req.param('platform');
    if (!Object.hasOwn(COST_FETCHERS, platform)) throw new HttpStatusError(400, 'Diese Plattform liefert keine Kosten');
    const days = intQuery(c, 'days', 30, 1, 365);
    const to = zonedDay(Date.now(), site.timezone);
    const synced = await syncCosts(db(), site, platform, { from: addDays(to, -(days - 1)), to });
    reportCache.clear();
    return c.json(synced);
  });

  app.get('/costs/manual', async (c) => {
    const site = await requireSite(c);
    const rows = await db().query(
      `select id, channel, label, amount::float8 as amount, date_from::text as "from", date_to::text as "to", created_at
       from manual_costs where site_id = $1 order by date_from desc`,
      [site.id],
    );
    return c.json({ rows });
  });

  app.post('/costs/manual', async (c) => {
    const site = await requireSite(c);
    const body = ManualCostSchema.parse(await readJson(c));
    if (body.from > body.to) throw new HttpStatusError(400, 'Beginn liegt nach Ende');
    const id = randomId('mc_', 9);
    await db().query(
      'insert into manual_costs (id, site_id, channel, label, amount, date_from, date_to) values ($1,$2,$3,$4,$5,$6,$7)',
      [id, site.id, body.channel, body.label, body.amount, body.from, body.to],
    );
    reportCache.clear();
    return c.json({ ok: true, id });
  });

  app.delete('/costs/manual/:costId', async (c) => {
    const site = await requireSite(c);
    await db().query('delete from manual_costs where site_id = $1 and id = $2', [site.id, c.req.param('costId')]);
    reportCache.clear();
    return c.json({ ok: true });
  });

  return app;
}
