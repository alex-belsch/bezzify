import { attachJourneys, loadOrderById } from '../attribution/engine.js';
import { config } from '../config.js';
import { one, type Queryable } from '../db/index.js';
import { decrypt, sha256Hex } from '../lib/crypto.js';
import type { FetchFn } from '../lib/http.js';
import { errMsg, log } from '../lib/log.js';
import type { MatchData } from '../orders/ingest.js';
import { getSiteById } from '../sites.js';
import { awinFeedback } from './awin.js';
import { googleFeedback } from './google.js';
import { metaFeedback } from './meta.js';
import { pinterestFeedback } from './pinterest.js';
import { getIntegration, redactSecrets, type Integration } from './store.js';
import { tiktokFeedback } from './tiktok.js';
import type { FeedbackOrder, FeedbackSender } from './types.js';

export const FEEDBACK_SENDERS: Record<string, FeedbackSender> = {
  meta: metaFeedback,
  google_ads: googleFeedback,
  tiktok: tiktokFeedback,
  pinterest: pinterestFeedback,
  awin: awinFeedback,
};

const BACKOFF_MIN = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const DAY = 86_400_000;
const CONFIRM_RECHECK_MIN = 60;
export const WAITING_FOR_SHOP = 'Wartet auf Bestätigung durch den Shop';

async function finish(q: Queryable, id: string, status: string, detail: string | null, response?: string) {
  await q.query(
    `update outbox set status = $2, last_error = $3, response = $4, sent_at = case when $2 = 'sent' then now() else sent_at end,
       attempts = attempts + 1 where id = $1`,
    [id, status, detail, response ?? null],
  );
}

export async function buildFeedbackOrder(q: Queryable, siteId: string, orderId: string): Promise<FeedbackOrder | null> {
  const site = await getSiteById(q, siteId);
  if (!site) return null;
  const stored = await one(q, 'select * from orders where site_id = $1 and id = $2', [siteId, orderId]);
  const order = await loadOrderById(q, site, orderId);
  if (!stored || !order) return null;
  // ohne Fenster, jeder Sender begrenzt selbst, die Cookie Laufzeit bei Awin kann über 90 Tagen liegen
  const journeys = await attachJourneys(q, site, [order], null, { verifiedIdentitiesOnly: true });
  const journey = (journeys.get(order.id) ?? []).filter((touch) => !touch.fromShop);
  const stableId = stored.customer_key ?? stored.visitor_id;
  return {
    externalId: stored.external_id,
    orderNumber: stored.order_number,
    createdAt: new Date(stored.created_at),
    currency: stored.currency,
    value: order.revenue,
    total: Number(stored.total),
    tax: Number(stored.tax),
    shipping: Number(stored.shipping),
    items: Array.isArray(stored.items) ? stored.items : [],
    emailHash: stored.email_sha256,
    phoneHash: stored.phone_sha256,
    externalIdHash: stableId ? sha256Hex(String(stableId)) : null,
    isNew: stored.is_new_customer,
    consentMarketing: stored.consent_marketing ?? null,
    match: decrypt<MatchData>(stored.match_data) ?? {},
    journey,
    landingUrl: stored.landing_url,
  };
}

export async function processOutbox(q: Queryable, opts: { limit?: number; fetchFn?: FetchFn } = {}): Promise<number> {
  const due = await q.query(
    `select * from outbox where status = 'pending' and next_attempt_at <= now() order by next_attempt_at limit $1`,
    [opts.limit ?? 25],
  );
  for (const entry of due) {
    let integration: Integration | null = null;
    try {
      const site = await getSiteById(q, entry.site_id);
      const order = site
        ? await one(q, 'select status, is_test, consent_marketing, source, created_at from orders where site_id = $1 and id = $2', [
            site.id,
            entry.order_id,
          ])
        : null;
      if (!site || !order) {
        await finish(q, entry.id, 'skipped', 'Bestellung nicht gefunden');
        continue;
      }
      if (order.status === 'cancelled' || order.is_test) {
        await finish(q, entry.id, 'skipped', 'storniert oder Testbestellung');
        continue;
      }
      if (order.source === 'pixel') {
        // meldet der Shop selbst, auf ihn warten (bei Vorkasse oft Tage später), längstens solange die Merkmale aufbewahrt werden
        const shopReports = await q.query(`select 1 from orders where site_id = $1 and source <> 'pixel' limit 1`, [site.id]);
        if (shopReports.length) {
          const age = Date.now() - new Date(order.created_at).getTime();
          if (age < config.matchDataRetentionDays * DAY) {
            await q.query('update outbox set next_attempt_at = $2, last_error = $3 where id = $1', [
              entry.id,
              new Date(Date.now() + CONFIRM_RECHECK_MIN * 60_000),
              WAITING_FOR_SHOP,
            ]);
          } else {
            await finish(q, entry.id, 'skipped', 'Bestellung nicht vom Shop bestätigt');
          }
          continue;
        }
      }
      if (site.settings.consentRequiredForFeedback && order.consent_marketing !== true) {
        await finish(q, entry.id, 'skipped', 'Keine Einwilligung für Marketing');
        continue;
      }
      integration = await getIntegration(q, site.id, entry.target);
      const sender = FEEDBACK_SENDERS[entry.target];
      if (!integration || !integration.enabled || !integration.values.feedback || !sender) {
        await finish(q, entry.id, 'skipped', 'Rückspielung deaktiviert');
        continue;
      }
      const feedbackOrder = await buildFeedbackOrder(q, site.id, entry.order_id);
      if (!feedbackOrder) {
        await finish(q, entry.id, 'skipped', 'Bestellung nicht gefunden');
        continue;
      }
      const outcome = await sender({ fetch: opts.fetchFn ?? fetch, site }, integration.values, feedbackOrder);
      await finish(q, entry.id, outcome.status, outcome.detail ?? null, outcome.response);
    } catch (e) {
      const attempts = Number(entry.attempts) + 1;
      const error = redactSecrets(entry.target, integration?.values ?? {}, errMsg(e)).slice(0, 1000);
      if (attempts >= MAX_ATTEMPTS) {
        await q.query(`update outbox set status = 'failed', attempts = $2, last_error = $3 where id = $1`, [entry.id, attempts, error]);
      } else {
        const nextAttempt = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000);
        await q.query(`update outbox set attempts = $2, last_error = $3, next_attempt_at = $4 where id = $1`, [
          entry.id,
          attempts,
          error,
          nextAttempt,
        ]);
      }
      log.warn('Rückspielung fehlgeschlagen', { target: entry.target, order: entry.order_id, attempts, error });
    }
  }
  return due.length;
}
