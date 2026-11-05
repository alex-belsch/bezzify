import { z } from 'zod';
import { config } from '../config.js';
import { one, type Queryable } from '../db/index.js';
import { randomId } from '../lib/crypto.js';
import {
  deviceFromUa,
  hashEmail,
  hashPhone,
  hashPhoneE164,
  normalizeCurrency,
  normalizeExternalId,
  toNumber,
  truncateIp,
} from '../lib/normalize.js';
import { anonymousUrl, originOnly, scrubUrl, withoutEmail } from '../lib/urls.js';
import { linkIdentity, lockOrder, upsertOrder, type OrderItem } from '../orders/ingest.js';
import type { Site } from '../sites.js';
import { classify, touchKey, type Touch } from './classify.js';

const str = (max: number) => z.string().max(max);
const flag = z.union([z.literal(0), z.literal(1), z.boolean()]).optional();

export const CollectSchema = z.object({
  k: str(64),
  v: str(64).nullish(),
  /** Einwilligung in die Messung (Statistik oder Marketing) */
  c: flag,
  /** zusätzlich Marketing: Rückspielung an Werbeplattformen erlaubt */
  mk: flag,
  s: str(32).optional(),
  m: z
    .object({ fbp: str(256).nullish(), fbc: str(512).nullish(), ttp: str(256).nullish(), epik: str(512).nullish() })
    .partial()
    .nullish(),
  e: z
    .array(
      z.object({
        n: str(64),
        id: str(64).optional(),
        t: z.number().optional(),
        u: str(4096).nullish(),
        r: str(4096).nullish(),
        p: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .min(1)
    .max(50),
});

export type CollectPayload = z.infer<typeof CollectSchema>;

export interface CollectContext {
  ip: string | null;
  ua: string | null;
  now: number;
}

interface SessionRow {
  id: string;
  last_seen_at: Date;
  channel: string;
  source: string | null;
  campaign: string | null;
  click_id: string | null;
  ext_campaign_id: string | null;
  ext_ad_id: string | null;
}

interface NewSession {
  visitorId: string | null;
  ts: number;
  touch: Touch;
  landingUrl: string | null;
  referrer: string | null;
  ua: string | null;
  ip: string | null;
  consent: boolean;
  pageviews: number;
}

const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Eventnamen in snake_case wie page_view, Namen wie __proto__ landen sonst als Schlüssel im Dashboard
const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

function eventName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return EVENT_NAME_RE.test(name) ? name : null;
}
const HOUR = 3600_000;

function eventTs(clientTs: number | undefined, now: number): number {
  // Der Browser puffert Events bis zur Einwilligung, sein Zeitstempel zählt nur, wenn er plausibel ist
  if (!clientTs || !Number.isFinite(clientTs)) return now;
  if (clientTs > now + 60_000 || clientTs < now - 6 * HOUR) return now;
  return clientTs;
}

async function createSession(q: Queryable, site: Site, session: NewSession): Promise<string> {
  const id = randomId('s_', 12);
  const { touch } = session;
  await q.query(
    `insert into sessions (id, site_id, visitor_id, started_at, last_seen_at, channel, source, medium, campaign, content, term,
       is_paid, click_id_type, click_id, ext_campaign_id, ext_adset_id, ext_ad_id, landing_url, referrer, device, ip_trunc,
       pageviews, event_count, consent)
     values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,1,$22)`,
    [
      id,
      site.id,
      session.visitorId,
      new Date(session.ts),
      touch.channel === 'internal' ? 'direct' : touch.channel,
      touch.source,
      touch.medium,
      // falsch eingerichtete UTM Werte enthalten manchmal die Mailadresse des Empfängers
      withoutEmail(touch.campaign),
      withoutEmail(touch.content),
      withoutEmail(touch.term),
      touch.isPaid,
      touch.clickIdType,
      touch.clickId,
      touch.extCampaignId,
      touch.extAdsetId,
      touch.extAdId,
      session.landingUrl?.slice(0, 2048) ?? null,
      session.referrer?.slice(0, 2048) ?? null,
      deviceFromUa(session.ua),
      truncateIp(session.ip),
      session.pageviews,
      session.consent,
    ],
  );
  return id;
}

/** Neue Session nach Inaktivität oder wenn ein Seitenaufruf über eine neue Quelle (Klick, Kampagne) kommt */
async function resolveSession(
  q: Queryable,
  site: Site,
  vid: string,
  ts: number,
  name: string,
  url: string | null,
  referrer: string | null,
  ctx: CollectContext,
): Promise<string> {
  const last = await one<SessionRow>(
    q,
    `select id, last_seen_at, channel, source, campaign, click_id, ext_campaign_id, ext_ad_id
     from sessions where site_id = $1 and visitor_id = $2 order by last_seen_at desc limit 1`,
    [site.id, vid],
  );
  const isPageView = name === 'page_view';
  const idleMs = last ? ts - new Date(last.last_seen_at).getTime() : Infinity;
  const active = idleMs < config.sessionTimeoutMinutes * 60_000;

  // Käufe gehören zur letzten Session, auch nach längerer Pause im Checkout
  if (last && !isPageView && (active || (name === 'purchase' && idleMs < 24 * HOUR))) {
    await q.query(
      `update sessions set last_seen_at = greatest(last_seen_at, $2), event_count = event_count + 1 where id = $1`,
      [last.id, new Date(ts)],
    );
    return last.id;
  }

  const touch = classify(url, referrer, {
    siteHosts: site.domains,
    clickIdWithoutParams: site.settings.clickIdWithoutParams,
  });
  const isNewSource = touch.channel !== 'internal' && touch.channel !== 'direct';
  const sameSource =
    !!last &&
    touchKey(touch) ===
      touchKey({
        channel: last.channel as Touch['channel'],
        source: last.source,
        campaign: last.campaign,
        clickId: last.click_id,
        extCampaignId: last.ext_campaign_id,
        extAdId: last.ext_ad_id,
      });

  if (last && active && (!isNewSource || sameSource)) {
    await q.query(
      `update sessions set last_seen_at = greatest(last_seen_at, $2),
         pageviews = pageviews + $3, event_count = event_count + 1 where id = $1`,
      [last.id, new Date(ts), isPageView ? 1 : 0],
    );
    return last.id;
  }

  return createSession(q, site, {
    visitorId: vid,
    ts,
    touch,
    landingUrl: scrubUrl(url),
    referrer: scrubUrl(referrer),
    ua: ctx.ua,
    ip: ctx.ip,
    consent: true,
    pageviews: isPageView ? 1 : 0,
  });
}

function asString(value: unknown, max = 256): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function parseItems(items: unknown): OrderItem[] | null {
  if (!Array.isArray(items)) return null;
  return items.slice(0, 200).map((item: Record<string, unknown> | null | undefined) => ({
    id: asString(item?.id ?? item?.product_id ?? item?.variant_id, 64),
    sku: asString(item?.sku, 64),
    name: asString(item?.name ?? item?.title, 200),
    quantity: Math.max(0, Math.round(toNumber(item?.quantity ?? item?.qty, 1))),
    price: toNumber(item?.price, 0),
  }));
}

export interface CollectResult {
  accepted: number;
  duplicates: number;
  visitorId: string | null;
  /** Marketing Einwilligung, für das Cookie _bzf_c (1 = nur Messung, 2 = mit Marketing) */
  marketing: boolean;
}

/**
 * Läuft in einer Transaktion. Gesperrt wird wie bei Webhook und Server API erst jede Bestellung, dann der Besucher,
 * so entstehen weder Deadlocks noch doppelte Sessions, wenn das Shopify Pixel zwei Events gleichzeitig sendet.
 */
export async function processCollect(
  q: Queryable,
  site: Site,
  payload: CollectPayload,
  ctx: CollectContext,
): Promise<CollectResult> {
  const consent = payload.c === 1 || payload.c === true;
  const vid = consent && payload.v && VID_RE.test(payload.v) ? payload.v : null;
  const marketing = !!vid && (payload.mk === 1 || payload.mk === true);
  const collected: CollectResult = { accepted: 0, duplicates: 0, visitorId: vid, marketing };
  const classifyOptions = { siteHosts: site.domains, clickIdWithoutParams: site.settings.clickIdWithoutParams };

  if (vid) {
    const orderIds = new Set<string>();
    for (const event of payload.e) {
      if (eventName(event.n) !== 'purchase') continue;
      const orderId = normalizeExternalId(asString(event.p?.order_id ?? event.p?.transaction_id, 128));
      if (orderId) orderIds.add(orderId);
    }
    for (const orderId of [...orderIds].sort()) await lockOrder(q, site.id, orderId);
    await q.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`collect:${site.id}:${vid}`]);
  }

  for (const event of payload.e) {
    const name = eventName(event.n);
    if (!name) continue;
    const ts = eventTs(event.t, ctx.now);
    const url = event.u ?? null;
    const referrer = event.r ?? null;

    if (!vid) {
      // Ohne Einwilligung zählen nur Einstiege, ohne Kennung, IP, Klick ID und Event
      if (name !== 'page_view') continue;
      const touch = classify(url, referrer, classifyOptions);
      if (touch.channel === 'internal') continue;
      await createSession(q, site, {
        visitorId: null,
        ts,
        touch: { ...touch, clickId: null },
        landingUrl: anonymousUrl(url),
        referrer: originOnly(referrer),
        ua: ctx.ua,
        ip: null,
        consent: false,
        pageviews: 1,
      });
      collected.accepted++;
      continue;
    }

    const eventId = asString(event.id, 64) ?? randomId('e_', 12);
    if (await one(q, 'select 1 from events where site_id = $1 and id = $2', [site.id, eventId])) {
      collected.duplicates++;
      continue;
    }

    const sessionId = await resolveSession(q, site, vid, ts, name, url, referrer, ctx);
    const props = { ...event.p };
    const emailHash = hashEmail(props.email ?? props.email_sha256);
    const phoneHash = hashPhone(props.phone ?? props.phone_sha256, site.settings.defaultCountryCode);
    const phoneE164Hash = hashPhoneE164(props.phone, site.settings.defaultCountryCode);
    delete props.email;
    delete props.phone;
    delete props.email_sha256;
    delete props.phone_sha256;

    await q.query(
      `insert into events (site_id, id, session_id, visitor_id, name, ts, url, props) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (site_id, id) do nothing`,
      [site.id, eventId, sessionId, vid, name, new Date(ts), scrubUrl(url), JSON.stringify(props)],
    );
    collected.accepted++;

    // Kundennummern aus dem Browser werden nicht verknüpft, sie sind oft fortlaufend und damit zu erraten
    if (emailHash) await linkIdentity(q, site.id, vid, 'email_sha256', emailHash);

    if (name !== 'purchase') continue;
    const orderId = asString(props.order_id ?? props.transaction_id, 128);
    if (!orderId) continue;
    const adCookies = payload.m ?? {};
    // IP, User Agent und Werbecookies dienen nur der Rückspielung und werden ohne Marketing Einwilligung gar nicht erst gespeichert
    const keepMatch = marketing || !site.settings.consentRequiredForFeedback;
    await upsertOrder(q, site, {
      externalId: orderId,
      orderNumber: asString(props.order_number, 64),
      createdAt: new Date(ts),
      currency: normalizeCurrency(props.currency),
      total: props.value !== undefined ? toNumber(props.value) : null,
      tax: props.tax !== undefined ? toNumber(props.tax) : null,
      shipping: props.shipping !== undefined ? toNumber(props.shipping) : null,
      discount: props.discount !== undefined ? toNumber(props.discount) : null,
      emailHash,
      phoneHash,
      customerId: asString(props.customer_id, 128),
      visitorId: vid,
      checkoutToken: asString(props.checkout_token, 128),
      items: parseItems(props.items),
      matchData: keepMatch
        ? {
            ip: ctx.ip,
            ua: ctx.ua,
            fbp: adCookies.fbp ?? null,
            fbc: adCookies.fbc ?? null,
            ttp: adCookies.ttp ?? null,
            epik: adCookies.epik ?? null,
            url: scrubUrl(url),
            phE164: phoneE164Hash,
          }
        : null,
      consentMarketing: marketing,
      source: 'pixel',
    });
  }
  return collected;
}
