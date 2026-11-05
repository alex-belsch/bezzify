import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import { hashEmail, hashPhone, hashPhoneE164, normalizeCurrency, normalizeExternalId } from '../lib/normalize.js';
import type { Site } from '../sites.js';
import { addRefund, lockOrder, setOrderStatus, upsertOrder } from './ingest.js';

const externalId = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((id) => normalizeExternalId(id) !== null, 'darf nicht leer sein');
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'kein gültiges Datum');
// Nebenfelder dürfen keine Bestellung kippen: zu lange Texte werden gekürzt, zu lange Kennungen verworfen
const clipped = (max: number) => z.string().nullish().transform((value) => (value == null ? value : value.slice(0, max)));
const droppedIfLonger = (max: number) => z.string().nullish().transform((value) => (value != null && value.length > max ? null : value));

/** Bestellungen von Shopware, WooCommerce oder eigenen Websites (Server zu Server) */
export const OrderApiSchema = z.object({
  order_id: externalId,
  order_number: z.union([z.string(), z.number()]).transform((value) => String(value).slice(0, 64)).nullish(),
  created_at: timestamp.nullish(),
  // ein ungültiger Code fällt auf die Shopwährung zurück, statt die Bestellung mit 400 zu verwerfen
  currency: z.string().nullish().transform(normalizeCurrency),
  total: z.number(),
  tax: z.number().nullish(),
  shipping: z.number().nullish(),
  discount: z.number().nullish(),
  status: z.enum(['pending', 'paid', 'cancelled']).nullish(),
  test: z.boolean().nullish(),
  email: droppedIfLonger(320),
  email_sha256: droppedIfLonger(64),
  phone: droppedIfLonger(64),
  customer_id: z.union([z.string(), z.number()]).transform((value) => String(value).slice(0, 128)).nullish(),
  is_new_customer: z.boolean().nullish(),
  visitor_id: droppedIfLonger(64),
  landing_url: clipped(4096),
  referrer: clipped(4096),
  items: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]).transform(String).nullish(),
        sku: clipped(64),
        name: clipped(200),
        quantity: z.number(),
        price: z.number(),
      }),
    )
    .transform((items) => items.slice(0, 500))
    .nullish(),
  ip: droppedIfLonger(64),
  user_agent: clipped(1024),
  fbp: droppedIfLonger(256),
  fbc: droppedIfLonger(512),
  ttp: droppedIfLonger(256),
  epik: droppedIfLonger(512),
  consent_marketing: z.boolean().nullish(),
});

export const RefundApiSchema = z.object({
  order_id: externalId,
  refund_id: externalId,
  amount: z.number().nonnegative(),
  created_at: timestamp.nullish(),
});

export async function ingestApiOrder(q: Queryable, site: Site, raw: unknown) {
  const order = OrderApiSchema.parse(raw);
  const phoneE164Hash = hashPhoneE164(order.phone, site.settings.defaultCountryCode);
  const hasMatch = order.ip || order.user_agent || order.fbp || order.fbc || order.ttp || order.epik || phoneE164Hash;
  return upsertOrder(q, site, {
    externalId: order.order_id,
    orderNumber: order.order_number ?? null,
    createdAt: order.created_at ? new Date(order.created_at) : new Date(),
    currency: order.currency ?? site.currency,
    total: order.total,
    tax: order.tax ?? 0,
    shipping: order.shipping ?? 0,
    discount: order.discount ?? 0,
    status: order.status ?? 'paid',
    isTest: order.test ?? false,
    customerId: order.customer_id ?? null,
    emailHash: hashEmail(order.email_sha256 ?? order.email),
    phoneHash: hashPhone(order.phone, site.settings.defaultCountryCode),
    isNewCustomer: order.is_new_customer ?? null,
    visitorId: order.visitor_id ?? null,
    landingUrl: order.landing_url ?? null,
    referrer: order.referrer ?? null,
    items:
      order.items?.map((item) => ({
        id: item.id ?? null,
        sku: item.sku ?? null,
        name: item.name ?? null,
        quantity: item.quantity,
        price: item.price,
      })) ?? null,
    matchData: hasMatch
      ? {
          ip: order.ip ?? null,
          ua: order.user_agent ?? null,
          fbp: order.fbp ?? null,
          fbc: order.fbc ?? null,
          ttp: order.ttp ?? null,
          epik: order.epik ?? null,
          phE164: phoneE164Hash,
        }
      : null,
    consentMarketing: order.consent_marketing ?? null,
    source: 'api',
  });
}

/** Muss in einer Transaktion laufen, die Sperre auf die Bestellung hält gleichzeitige Erstattungen auseinander */
export async function ingestApiRefund(q: Queryable, site: Site, raw: unknown) {
  const refund = RefundApiSchema.parse(raw);
  await lockOrder(q, site.id, normalizeExternalId(refund.order_id)!);
  await addRefund(q, site, {
    externalId: refund.refund_id,
    orderExternalId: refund.order_id,
    amount: refund.amount,
    createdAt: refund.created_at ? new Date(refund.created_at) : new Date(),
  });
}

export async function cancelApiOrder(q: Queryable, site: Site, orderId: string) {
  await setOrderStatus(q, site, orderId, 'cancelled');
}
