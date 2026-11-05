import type { Queryable } from '../db/index.js';
import { hmacSha256, safeEqual } from '../lib/crypto.js';
import { hashEmail, hashPhone, hashPhoneE164, normalizeCurrency, normalizeExternalId, toNumber } from '../lib/normalize.js';
import type { Site } from '../sites.js';
import { addRefund, lockOrder, upsertOrder, type OrderInput, type OrderStatus } from './ingest.js';

export function verifyShopifyHmac(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean {
  if (!headerValue || !secret) return false;
  const digest = hmacSha256(secret, rawBody).toString('base64');
  return safeEqual(digest, headerValue.trim());
}

const PAID_STATES = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);

function noteAttribute(order: any, names: string[]): string | null {
  const attributes: any[] = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  for (const attribute of attributes) {
    if (names.includes(String(attribute?.name))) return attribute?.value ? String(attribute.value) : null;
  }
  return null;
}

function absolutize(path: string | null | undefined, site: Site): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const host = site.domains[0];
  return host ? `https://${host}${path.startsWith('/') ? '' : '/'}${path}` : null;
}

export function mapShopifyOrder(order: any, site: Site): OrderInput {
  const status: OrderStatus = order.cancelled_at ? 'cancelled' : PAID_STATES.has(order.financial_status) ? 'paid' : 'pending';
  const shipping =
    order.total_shipping_price_set?.shop_money?.amount ??
    (Array.isArray(order.shipping_lines) ? order.shipping_lines.reduce((sum: number, line: any) => sum + toNumber(line.price), 0) : 0);
  const phone = order.phone ?? order.customer?.phone ?? order.billing_address?.phone;
  const phoneE164Hash = hashPhoneE164(phone, site.settings.defaultCountryCode);
  return {
    externalId: String(order.id),
    orderNumber: order.name ?? (order.order_number ? String(order.order_number) : null),
    createdAt: order.created_at ? new Date(order.created_at) : new Date(),
    currency: normalizeCurrency(order.currency) ?? site.currency,
    total: toNumber(order.total_price),
    tax: toNumber(order.total_tax),
    shipping: toNumber(shipping),
    discount: toNumber(order.total_discounts),
    status,
    isTest: !!order.test,
    customerId: order.customer?.id ? String(order.customer.id) : null,
    emailHash: hashEmail(order.email ?? order.contact_email ?? order.customer?.email),
    phoneHash: hashPhone(phone, site.settings.defaultCountryCode),
    visitorId: noteAttribute(order, ['_bzf_id', 'bzf_id']),
    checkoutToken: order.checkout_token ?? null,
    landingUrl: absolutize(order.landing_site, site),
    referrer: order.referring_site || null,
    items: Array.isArray(order.line_items)
      ? order.line_items.map((lineItem: any) => ({
          id: lineItem.product_id ? String(lineItem.product_id) : null,
          sku: lineItem.sku || null,
          name: lineItem.title ?? lineItem.name ?? null,
          quantity: Number(lineItem.quantity ?? 1),
          price: toNumber(lineItem.price),
        }))
      : null,
    matchData:
      order.browser_ip || order.client_details?.user_agent || phoneE164Hash
        ? { ip: order.browser_ip ?? null, ua: order.client_details?.user_agent ?? null, phE164: phoneE164Hash }
        : null,
    source: 'webhook',
  };
}

export function refundAmount(refund: any): number {
  const transactions: any[] = Array.isArray(refund?.transactions) ? refund.transactions : [];
  const fromTransactions = transactions
    .filter((t) => (t.kind === 'refund' || t.kind === 'REFUND') && (t.status === 'success' || t.status === 'SUCCESS'))
    .reduce((sum, t) => sum + toNumber(t.amount), 0);
  if (fromTransactions > 0) return fromTransactions;
  const lines: any[] = Array.isArray(refund?.refund_line_items) ? refund.refund_line_items : [];
  const fromLines = lines.reduce((sum, line) => sum + toNumber(line.subtotal) + toNumber(line.total_tax), 0);
  const adjustments: any[] = Array.isArray(refund?.order_adjustments) ? refund.order_adjustments : [];
  return fromLines - adjustments.reduce((sum, adjustment) => sum + toNumber(adjustment.amount), 0);
}

export async function handleShopifyWebhook(q: Queryable, site: Site, topic: string, body: any): Promise<string> {
  switch (topic) {
    case 'orders/create':
    case 'orders/updated':
    case 'orders/paid':
    case 'orders/cancelled': {
      await upsertOrder(q, site, mapShopifyOrder(body, site));
      return 'order';
    }
    case 'refunds/create': {
      const orderExternalId = String(body.order_id);
      // gleichzeitige Erstattungen derselben Bestellung würden sonst die Summe der jeweils anderen überschreiben
      const orderId = normalizeExternalId(orderExternalId);
      if (orderId) await lockOrder(q, site.id, orderId);
      await addRefund(q, site, {
        externalId: String(body.id),
        orderExternalId,
        amount: refundAmount(body),
        createdAt: body.created_at ? new Date(body.created_at) : new Date(),
      });
      return 'refund';
    }
    default:
      return 'ignored';
  }
}
