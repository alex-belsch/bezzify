// Bezzify Custom Pixel für Shopify
//
// Einrichtung:
// 1. Shopify Admin > Einstellungen > Kundenereignisse > Benutzerdefiniertes Pixel hinzufügen, Name "Bezzify"
// 2. Diesen Code einfügen (das Bezzify Dashboard füllt Endpoint und Site Key bereits aus)
// 3. Kundendatenschutz: Berechtigung "Erforderlich", Kategorie Analysen
//    So läuft das Pixel nur mit Einwilligung. Ob Käufe an Werbeplattformen zurückgespielt werden,
//    entscheidet das Pixel selbst anhand der Marketing Einwilligung.
//    Wer Attribution als Marketing einstuft, wählt zusätzlich Marketing.
// 4. Speichern und "Verbinden"
//
// Das Pixel läuft auf allen Shopseiten und im Checkout. Ein zusätzliches Skript im Theme ist nicht nötig.

const BZF_ENDPOINT = '__ENDPOINT__';
const BZF_SITE = '__SITE_KEY__';
const ID_COOKIE = '_bzf_id';
const CONSENT_COOKIE = '_bzf_c';
const COOKIE_ATTRIBUTES = `path=/; max-age=${400 * 24 * 3600}; SameSite=Lax; Secure`;
const DELETE_ATTRIBUTES = 'path=/; max-age=0; SameSite=Lax; Secure';

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 0 keine Einwilligung, 1 nur Analysen (Messung), 2 Marketing (Messung und Rückspielung), wie im Cookie _bzf_c
function levelOf(privacy) {
  if (!privacy) return 0;
  return privacy.marketingAllowed ? 2 : privacy.analyticsProcessingAllowed ? 1 : 0;
}

// Ohne Angabe gilt die Analyse Einwilligung, unter der Shopify das Pixel laut Einrichtung überhaupt lädt
let level = init.customerPrivacy ? levelOf(init.customerPrivacy) : 1;
let visitorPromise = null;
let writtenLevel = 0;

async function loadVisitorId() {
  let id = await browser.cookie.get(ID_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) id = randomId();
  await browser.cookie.set(`${ID_COOKIE}=${id}; ${COOKIE_ATTRIBUTES}`);
  return id;
}

async function visitorId() {
  if (!visitorPromise) {
    // Nach einem Fehler beim nächsten Event neu versuchen, statt jedes weitere Event am selben Fehler scheitern zu lassen
    visitorPromise = loadVisitorId().catch((error) => {
      visitorPromise = null;
      throw error;
    });
  }
  const id = await visitorPromise;
  if (writtenLevel !== level) {
    const current = level;
    await browser.cookie.set(`${CONSENT_COOKIE}=${current}; ${COOKIE_ATTRIBUTES}`);
    writtenLevel = current;
  }
  return id;
}

async function forgetVisitor() {
  visitorPromise = null;
  writtenLevel = 0;
  await browser.cookie.set(`${ID_COOKIE}=; ${DELETE_ATTRIBUTES}`);
  await browser.cookie.set(`${CONSENT_COOKIE}=; ${DELETE_ATTRIBUTES}`);
}

async function readCookie(name) {
  return (await browser.cookie.get(name)) || null;
}

function amount(money) {
  const value = Number(money?.amount);
  return Number.isFinite(value) ? value : undefined;
}

api.customerPrivacy.subscribe('visitorConsentCollected', (event) => {
  level = levelOf(event.customerPrivacy);
  if (!level) forgetVisitor().catch((error) => console.warn('Bezzify: Cookies nicht gelöscht', error));
});

async function send(name, event, props) {
  if (!level) return;
  const marketing = level === 2;
  const doc = event.context?.document ?? {};
  // Werbecookies dienen nur der Rückspielung und werden nur mit Marketing Einwilligung gelesen
  const [vid, fbp, fbc, ttp, epik] = await Promise.all([
    visitorId(),
    marketing ? readCookie('_fbp') : null,
    marketing ? readCookie('_fbc') : null,
    marketing ? readCookie('_ttp') : null,
    marketing ? readCookie('_epik') : null,
  ]);
  const payload = {
    k: BZF_SITE,
    v: vid,
    c: 1,
    mk: marketing ? 1 : 0,
    s: 'shopify_pixel',
    m: marketing ? { fbp, fbc, ttp, epik } : null,
    e: [
      {
        n: name,
        id: event.id,
        t: Date.parse(event.timestamp) || Date.now(),
        u: doc.location?.href ?? null,
        r: doc.referrer || null,
        p: props,
      },
    ],
  };
  fetch(`${BZF_ENDPOINT}/v1/collect`, {
    method: 'POST',
    body: JSON.stringify(payload),
    keepalive: true,
    headers: { 'Content-Type': 'text/plain' },
  }).catch(() => {});
}

function on(shopifyEvent, name, toProps) {
  analytics.subscribe(shopifyEvent, (event) => {
    send(name, event, toProps(event)).catch((error) => console.warn(`Bezzify: ${name} nicht gesendet`, error));
  });
}

on('page_viewed', 'page_view', (event) => ({ title: event.context?.document?.title }));

on('product_viewed', 'view_item', (event) => {
  const variant = event.data?.productVariant;
  if (!variant) return {};
  return {
    item_id: variant.product?.id,
    variant_id: variant.id,
    name: variant.product?.title,
    value: amount(variant.price),
    currency: variant.price?.currencyCode,
  };
});

on('product_added_to_cart', 'add_to_cart', (event) => {
  const cartLine = event.data?.cartLine;
  if (!cartLine) return {};
  return {
    variant_id: cartLine.merchandise?.id,
    quantity: cartLine.quantity,
    value: amount(cartLine.cost?.totalAmount),
    currency: cartLine.cost?.totalAmount?.currencyCode,
  };
});

on('checkout_started', 'begin_checkout', (event) => {
  const checkout = event.data?.checkout ?? {};
  return { value: amount(checkout.totalPrice), currency: checkout.currencyCode, checkout_token: checkout.token };
});

on('checkout_contact_info_submitted', 'identify', (event) => {
  const checkout = event.data?.checkout ?? {};
  return { email: checkout.email || undefined, phone: checkout.phone || undefined };
});

on('checkout_completed', 'purchase', (event) => {
  const checkout = event.data?.checkout ?? {};
  const order = checkout.order ?? {};
  return {
    order_id: order.id,
    value: amount(checkout.totalPrice),
    currency: checkout.currencyCode,
    tax: amount(checkout.totalTax),
    shipping: amount(checkout.shippingLine?.price),
    checkout_token: checkout.token,
    email: checkout.email || undefined,
    phone: checkout.phone || undefined,
    customer_id: order.customer?.id || undefined,
    items: (checkout.lineItems ?? []).map((lineItem) => ({
      id: lineItem.variant?.product?.id,
      sku: lineItem.variant?.sku,
      name: lineItem.title,
      quantity: lineItem.quantity,
      price: amount(lineItem.variant?.price),
    })),
  };
});
