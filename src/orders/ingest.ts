import { config } from '../config.js';
import { one, type Queryable } from '../db/index.js';
import { decrypt, encrypt, randomId } from '../lib/crypto.js';
import { customerKey, normalizeExternalId, round2 } from '../lib/normalize.js';
import { scrubUrl } from '../lib/urls.js';
import type { Site } from '../sites.js';

const DAY = 86_400_000;

export interface OrderItem {
  id?: string | null;
  sku?: string | null;
  name?: string | null;
  quantity: number;
  price: number;
}

/** Nur für die Rückspielung an Werbeplattformen, verschlüsselt und nach kurzer Zeit gelöscht */
export interface MatchData {
  ip?: string | null;
  ua?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  ttp?: string | null;
  epik?: string | null;
  url?: string | null;
  /** SHA 256 der Telefonnummer mit Pluszeichen (E.164), so verlangt es TikTok */
  phE164?: string | null;
}

export type OrderSource = 'pixel' | 'webhook' | 'api';
export type OrderStatus = 'pending' | 'paid' | 'cancelled';

export interface OrderInput {
  externalId: string;
  orderNumber?: string | null;
  createdAt?: Date | null;
  currency?: string | null;
  total?: number | null;
  tax?: number | null;
  shipping?: number | null;
  discount?: number | null;
  status?: OrderStatus | null;
  isTest?: boolean | null;
  customerId?: string | null;
  emailHash?: string | null;
  phoneHash?: string | null;
  isNewCustomer?: boolean | null;
  visitorId?: string | null;
  checkoutToken?: string | null;
  landingUrl?: string | null;
  referrer?: string | null;
  items?: OrderItem[] | null;
  matchData?: MatchData | null;
  consentMarketing?: boolean | null;
  source: OrderSource;
}

export const FEEDBACK_TARGETS = ['meta', 'google_ads', 'tiktok', 'pinterest', 'awin'] as const;
export type FeedbackTarget = (typeof FEEDBACK_TARGETS)[number];

interface OrderRow {
  id: string;
  external_id: string;
  order_number: string | null;
  created_at: Date;
  currency: string;
  total: unknown;
  tax: unknown;
  shipping: unknown;
  discount: unknown;
  status: string;
  is_test: boolean;
  customer_key: string | null;
  email_sha256: string | null;
  phone_sha256: string | null;
  is_new_customer: boolean | null;
  visitor_id: string | null;
  checkout_token: string | null;
  landing_url: string | null;
  referrer: string | null;
  match_data: string | null;
  match_data_at: Date | null;
  consent_marketing: boolean | null;
  source: OrderSource;
}

function mergeMatch(existing: string | null, incoming: MatchData | null | undefined): string | null {
  if (!incoming) return existing;
  const merged: Record<string, unknown> = { ...decrypt<MatchData>(existing) };
  for (const [key, value] of Object.entries(incoming)) if (value) merged[key] = value;
  return Object.keys(merged).length ? encrypt(merged) : existing;
}

async function computeIsNew(
  q: Queryable,
  siteId: string,
  cKey: string | null,
  emailHash: string | null,
  createdAt: Date,
): Promise<boolean | null> {
  if (!cKey && !emailHash) return null;
  const prior = await one(
    q,
    `select 1 from orders where site_id = $1 and created_at < $2 and status <> 'cancelled'
       and ((customer_key is not null and customer_key = $3) or (email_sha256 is not null and email_sha256 = $4))
     limit 1`,
    [siteId, createdAt, cKey, emailHash],
  );
  return !prior;
}

export async function linkIdentity(q: Queryable, siteId: string, visitorId: string, kind: string, value: string, verified = false) {
  await q.query(
    `insert into identities (site_id, visitor_id, kind, value, verified) values ($1,$2,$3,$4,$5)
     on conflict (site_id, visitor_id, kind, value) do update set last_seen = now(), verified = identities.verified or excluded.verified`,
    [siteId, visitorId, kind, value, verified],
  );
}

export interface UpsertResult {
  id: string;
  created: boolean;
  /** Pixel Meldung passte nicht zur vorhandenen Bestellung und wurde verworfen */
  ignored: boolean;
}

/**
 * Sperrt eine Bestellnummer bis zum Ende der Transaktion. Überall gilt dieselbe Reihenfolge (Bestellungen, Besucher,
 * einzelne Zeilen), sonst könnten sich Pixel und Webhook derselben Bestellung gegenseitig blockieren.
 */
export async function lockOrder(q: Queryable, siteId: string, ext: string) {
  await q.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`order:${siteId}:${ext}`]);
}

async function findOrder(q: Queryable, siteId: string, ext: string, checkoutToken: string | null): Promise<OrderRow | null> {
  const byId = await one<OrderRow>(q, 'select * from orders where site_id = $1 and external_id = $2 for update', [siteId, ext]);
  if (byId || !checkoutToken) return byId;
  return one<OrderRow>(
    q,
    'select * from orders where site_id = $1 and checkout_token = $2 order by created_at desc limit 1 for update',
    [siteId, checkoutToken],
  );
}

async function afterWrite(
  q: Queryable,
  site: Site,
  id: string,
  vid: string | null,
  emailHash: string | null,
  cKey: string | null,
  status: string,
  isTest: boolean,
  shopConfirmed: boolean,
) {
  if (vid) {
    if (emailHash) await linkIdentity(q, site.id, vid, 'email_sha256', emailHash, shopConfirmed);
    // Kundennummern sind oft fortlaufend und damit zu erraten, aus dem Browser allein wird keine verknüpft
    if (cKey && shopConfirmed) await linkIdentity(q, site.id, vid, 'customer', cKey, true);
  }
  if (status !== 'cancelled' && !isTest) await enqueueFeedback(q, site, id);
}

/** IP, User Agent und Werbecookies nur mit Marketing Einwilligung, außer der Shop verlangt sie nicht */
function matchAllowed(site: Site, consent: boolean | null | undefined): boolean {
  return consent === true || !site.settings.consentRequiredForFeedback;
}

/**
 * Shop Meldungen (Webhook, Server API) sind maßgeblich. Das Pixel kann jeder mit dem öffentlichen Site Key nachahmen,
 * bei einer Shop Bestellung zählen seine Angaben deshalb nur mit gleichem Checkout, gleicher Mail, Telefonnummer oder gleichem Besucher.
 */
export async function upsertOrder(q: Queryable, site: Site, raw: OrderInput): Promise<UpsertResult> {
  const ext = normalizeExternalId(raw.externalId);
  if (!ext) throw new Error('Bestell ID fehlt');
  await lockOrder(q, site.id, ext);
  const cKey = customerKey(site.id, raw.customerId);
  const input: OrderInput = {
    ...raw,
    landingUrl: scrubUrl(raw.landingUrl),
    referrer: scrubUrl(raw.referrer),
    matchData: raw.matchData ? { ...raw.matchData, url: scrubUrl(raw.matchData.url) } : null,
  };

  let existing = await findOrder(q, site.id, ext, input.checkoutToken ?? null);
  if (!existing) {
    const id = randomId('ord_', 12);
    const createdAt = input.createdAt ?? new Date();
    const isNew = input.isNewCustomer ?? (await computeIsNew(q, site.id, cKey, input.emailHash ?? null, createdAt));
    const matchData = input.matchData && matchAllowed(site, input.consentMarketing) ? input.matchData : null;
    const inserted = await q.query(
      `insert into orders (id, site_id, external_id, order_number, created_at, currency, total, tax, shipping, discount,
         status, is_test, customer_key, email_sha256, phone_sha256, is_new_customer, visitor_id, checkout_token,
         landing_url, referrer, items, match_data, match_data_at, consent_marketing, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       on conflict (site_id, external_id) do nothing
       returning id`,
      [
        id,
        site.id,
        ext,
        input.orderNumber ?? null,
        createdAt,
        (input.currency ?? site.currency).toUpperCase(),
        round2(input.total ?? 0),
        round2(input.tax ?? 0),
        round2(input.shipping ?? 0),
        round2(input.discount ?? 0),
        input.status ?? 'paid',
        input.isTest ?? false,
        cKey,
        input.emailHash ?? null,
        input.phoneHash ?? null,
        isNew,
        input.visitorId ?? null,
        input.checkoutToken ?? null,
        input.landingUrl ?? null,
        input.referrer ?? null,
        input.items ? JSON.stringify(input.items) : null,
        matchData ? encrypt(matchData) : null,
        matchData ? new Date() : null,
        input.consentMarketing ?? null,
        input.source,
      ],
    );
    if (inserted.length) {
      const shopConfirmed = input.source !== 'pixel';
      await afterWrite(q, site, id, input.visitorId ?? null, input.emailHash ?? null, cKey, input.status ?? 'paid', input.isTest ?? false, shopConfirmed);
      return { id, created: true, ignored: false };
    }
    // im selben Moment von einer anderen Meldung angelegt, also als Aktualisierung weiter
    existing = await findOrder(q, site.id, ext, null);
    if (!existing) throw new Error('Bestellung konnte nicht gespeichert werden');
  }
  return updateOrder(q, site, existing, ext, cKey, input);
}

async function updateOrder(
  q: Queryable,
  site: Site,
  existing: OrderRow,
  ext: string,
  cKey: string | null,
  input: OrderInput,
): Promise<UpsertResult> {
  const id = existing.id;
  const authoritative = input.source !== 'pixel';
  const fromPixel = existing.source === 'pixel';

  const tokenMatch = !!input.checkoutToken && input.checkoutToken === existing.checkout_token;
  const contactMatch =
    (!!input.emailHash && input.emailHash === existing.email_sha256) || (!!input.phoneHash && input.phoneHash === existing.phone_sha256);
  const sameVisitor = !!input.visitorId && input.visitorId === existing.visitor_id;
  const related = tokenMatch || contactMatch || sameVisitor;

  if (!authoritative && !related) {
    // Pixel Meldungen ohne Bezug verwerfen, sonst ließen sich Einwilligung, Besucher und Werbecookies fremder Bestellungen umbiegen
    return { id, created: false, ignored: true };
  }
  // Kam zuerst nur das Pixel und passt es nicht zur Meldung des Shops, gelten seine Angaben nicht
  const keep = !(authoritative && fromPixel && !related);
  const prior = <T>(v: T): T | null => (keep ? v : null);
  // Shop Meldungen und Pixel Meldungen auf Pixel Bestellungen überschreiben, das Pixel ergänzt Shop Bestellungen nur
  const incomingWins = authoritative || fromPixel;
  const pick = <T>(incoming: T | null | undefined, current: T | null): T | null =>
    incomingWins ? (incoming ?? prior(current)) : (current ?? incoming ?? null);

  const visitorId = authoritative ? (input.visitorId ?? prior(existing.visitor_id)) : (existing.visitor_id ?? input.visitorId ?? null);
  const shopConsent: boolean | null = fromPixel ? null : existing.consent_marketing;
  const consent = authoritative
    ? (input.consentMarketing ?? prior(existing.consent_marketing))
    : (shopConsent ?? input.consentMarketing ?? existing.consent_marketing ?? null);

  const takeFinancials = authoritative || fromPixel;
  const createdAt: Date = takeFinancials && input.createdAt ? input.createdAt : existing.created_at;
  const emailHash = pick(input.emailHash, existing.email_sha256);
  const phoneHash = pick(input.phoneHash, existing.phone_sha256);
  const customerKeyValue = pick(cKey, existing.customer_key);
  let isNew = pick(input.isNewCustomer, existing.is_new_customer);
  if (isNew == null && (customerKeyValue || emailHash)) {
    isNew = await computeIsNew(q, site.id, customerKeyValue, emailHash, new Date(createdAt));
  }

  // Merkmale für die Rückspielung werden nach Ablauf der Frist gelöscht und danach nie wieder gespeichert
  let matchData: string | null = prior(existing.match_data);
  let matchDataAt: Date | null = prior(existing.match_data_at);
  const purged = !!existing.match_data_at && !existing.match_data;
  const tooOld = Date.now() - new Date(existing.created_at).getTime() > config.matchDataRetentionDays * DAY;
  if (!matchAllowed(site, consent)) {
    // ein Löschvermerk (Zeitpunkt ohne Daten) bleibt stehen
    if (matchData) matchDataAt = null;
    matchData = null;
  } else if (input.matchData && !purged && !tooOld) {
    matchData = mergeMatch(matchData, input.matchData);
    if (matchData && !matchDataAt) matchDataAt = new Date();
  }

  const replaceItems = (takeFinancials && !!input.items) || !keep;
  const status: string = takeFinancials && input.status ? input.status : existing.status;
  const isTest: boolean = takeFinancials && input.isTest != null ? input.isTest : existing.is_test;

  await q.query(
    `update orders set
       external_id = $3,
       order_number = $4,
       created_at = $5,
       currency = $6,
       total = $7, tax = $8, shipping = $9, discount = $10,
       status = $11,
       is_test = $12,
       customer_key = $13,
       email_sha256 = $14,
       phone_sha256 = $15,
       is_new_customer = $16,
       visitor_id = $17,
       checkout_token = $18,
       landing_url = $19,
       referrer = $20,
       items = case when $21::boolean then $22::jsonb else items end,
       match_data = $23,
       match_data_at = $24,
       consent_marketing = $25,
       source = $26,
       updated_at = now()
     where id = $1 and site_id = $2`,
    [
      id,
      site.id,
      authoritative ? ext : existing.external_id,
      pick(input.orderNumber, existing.order_number),
      createdAt,
      takeFinancials && input.currency ? input.currency.toUpperCase() : existing.currency,
      takeFinancials && input.total != null ? round2(input.total) : existing.total,
      takeFinancials && input.tax != null ? round2(input.tax) : existing.tax,
      takeFinancials && input.shipping != null ? round2(input.shipping) : existing.shipping,
      takeFinancials && input.discount != null ? round2(input.discount) : existing.discount,
      status,
      isTest,
      customerKeyValue,
      emailHash,
      phoneHash,
      isNew,
      visitorId,
      pick(input.checkoutToken, existing.checkout_token),
      pick(input.landingUrl, existing.landing_url),
      pick(input.referrer, existing.referrer),
      replaceItems,
      input.items ? JSON.stringify(input.items) : null,
      matchData,
      matchDataAt,
      consent,
      authoritative ? input.source : existing.source,
    ],
  );

  const source = authoritative ? input.source : existing.source;
  await afterWrite(q, site, id, visitorId, emailHash, customerKeyValue, status, isTest, source !== 'pixel');
  return { id, created: false, ignored: false };
}

export async function setOrderStatus(q: Queryable, site: Site, externalId: string, status: OrderStatus) {
  const ext = normalizeExternalId(externalId);
  await q.query('update orders set status = $3, updated_at = now() where site_id = $1 and external_id = $2', [
    site.id,
    ext,
    status,
  ]);
}

export async function addRefund(
  q: Queryable,
  site: Site,
  input: { externalId: string; orderExternalId: string; amount: number; createdAt?: Date },
) {
  const orderExt = normalizeExternalId(input.orderExternalId);
  await q.query(
    `insert into refunds (site_id, external_id, order_external_id, amount, created_at) values ($1,$2,$3,$4,$5)
     on conflict (site_id, external_id) do update set amount = excluded.amount`,
    [site.id, String(input.externalId), orderExt, round2(input.amount), input.createdAt ?? new Date()],
  );
  await q.query(
    `update orders set refunded = (select coalesce(sum(amount), 0) from refunds where site_id = $1 and order_external_id = $2),
       updated_at = now()
     where site_id = $1 and external_id = $2`,
    [site.id, orderExt],
  );
}

export async function enqueueFeedback(q: Queryable, site: Site, orderId: string) {
  const rows = await q.query<{ platform: string }>(
    `select platform from integrations
     where site_id = $1 and enabled and coalesce((config->>'feedback')::boolean, false)`,
    [site.id],
  );
  const delayMs = Math.max(0, site.settings.feedbackDelayMinutes) * 60_000;
  for (const { platform } of rows) {
    if (!(FEEDBACK_TARGETS as readonly string[]).includes(platform)) continue;
    // Wartet ein Eintrag noch (etwa auf die Bestätigung durch den Shop), rückt er jetzt nach vorn
    await q.query(
      `insert into outbox (id, site_id, target, order_id, next_attempt_at) values ($1,$2,$3,$4,$5)
       on conflict (site_id, target, order_id) do update set next_attempt_at = least(outbox.next_attempt_at, excluded.next_attempt_at)
       where outbox.status = 'pending' and outbox.attempts = 0`,
      [randomId('ob_', 10), site.id, platform, orderId, new Date(Date.now() + delayMs)],
    );
  }
}
