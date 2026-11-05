/**
 * Bestellungen von eigenen Websites (z.B. Next.js) an Bezzify melden.
 *
 * Ablauf:
 * 1. Tracking Skript im Layout einbinden (Snippet aus dem Dashboard)
 * 2. Beim Erstellen des Checkouts die Besucher ID mitgeben, z.B. als Stripe Metadata,
 *    denn Zahlungs Webhooks kommen ohne Cookies an:
 *      const ctx = await bezzifyContext(); // im Request des Kunden
 *      stripe.checkout.sessions.create({ ..., metadata: { bzf: JSON.stringify(ctx) } })
 * 3. Im Zahlungs Webhook die Bestellung melden:
 *      await sendOrder({ order_id: session.id, total: session.amount_total / 100, ...JSON.parse(session.metadata.bzf) })
 *    Fehler nicht abfangen: wirft sendOrder, antwortet der Webhook mit 500 und Stripe stellt ihn später
 *    erneut zu. So geht keine Bestellung verloren, wenn Bezzify kurz nicht erreichbar ist.
 * 4. Optional die Frage nach dem Kauf: surveyQuestion() auf der Danke Seite zeigen und die gewählte Antwort
 *    vom eigenen Server mit sendSurveyAnswer(orderId, answerId) melden. Nur auf der Seite, per Mail wäre sie Werbung.
 *
 * Einwilligung: Das Cookie _bzf_c steht auf 1 (nur Messung) oder 2 (Messung und Marketing).
 * Nur mit 2 gehen IP, User Agent und Werbecookies mit und Käufe an Werbeplattformen.
 *
 * Umgebungsvariablen: BEZZIFY_URL (z.B. https://t.deinshop.de), BEZZIFY_SECRET (sk_...)
 * und für die Frage nach dem Kauf BEZZIFY_SITE_KEY (pk_...)
 */

export interface BezzifyContext {
  visitor_id: string | null;
  consent_marketing: boolean;
  ip?: string | null;
  user_agent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  ttp?: string | null;
  epik?: string | null;
}

export interface BezzifyOrder extends Partial<BezzifyContext> {
  order_id: string;
  order_number?: string;
  created_at?: string;
  currency?: string;
  total: number;
  tax?: number;
  shipping?: number;
  discount?: number;
  status?: 'pending' | 'paid' | 'cancelled';
  email?: string | null;
  phone?: string | null;
  customer_id?: string | null;
  is_new_customer?: boolean | null;
  items?: { id?: string; sku?: string; name?: string; quantity: number; price: number }[];
  test?: boolean;
}

type CookieReader = { get(name: string): { value: string } | undefined };
type HeaderReader = { get(name: string): string | null };

const RETRY_DELAYS_MS = [0, 1000, 4000];

export function readBezzifyContext(cookies: CookieReader, headers: HeaderReader): BezzifyContext {
  const level = cookies.get('_bzf_c')?.value;
  const stored = cookies.get('_bzf_id')?.value;
  const visitorId = (level === '1' || level === '2') && stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored) ? stored : null;
  // Nur Messung, also Besucher ja, aber nichts für die Werbeplattformen
  if (level !== '2') return { visitor_id: visitorId, consent_marketing: false };
  return {
    visitor_id: visitorId,
    consent_marketing: true,
    ip: headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    user_agent: headers.get('user-agent'),
    fbp: cookies.get('_fbp')?.value ?? null,
    fbc: cookies.get('_fbc')?.value ?? null,
    ttp: cookies.get('_ttp')?.value ?? null,
    epik: cookies.get('_epik')?.value ?? null,
  };
}

/** Für den Next.js App Router, im Server Code (Route Handler, Server Action) des Kundenrequests aufrufen, nicht im Webhook */
export async function bezzifyContext(): Promise<BezzifyContext> {
  const { cookies, headers } = await import('next/headers' as string);
  return readBezzifyContext(await cookies(), await headers());
}

/** Wiederholt kurz bei Netzwerkfehlern, 5xx und 429 und wirft danach, damit Webhook oder Job Queue später neu zustellen. */
async function post(path: string, payload: unknown): Promise<void> {
  const baseUrl = process.env.BEZZIFY_URL;
  const secret = process.env.BEZZIFY_SECRET;
  if (!baseUrl || !secret) throw new Error('BEZZIFY_URL oder BEZZIFY_SECRET fehlt');
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const body = JSON.stringify(payload);
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.ok) return;
    const detail = await response.text().catch(() => '');
    lastError = new Error(`Bezzify ${path}: HTTP ${response.status} ${detail.slice(0, 300)}`);
    // Bei ungültigen Daten oder falschem Schlüssel hilft sofortiges Wiederholen nicht
    if (response.status < 500 && response.status !== 429) throw lastError;
  }
  throw lastError;
}

export function sendOrder(order: BezzifyOrder) {
  return post('/v1/orders', order);
}

export function sendRefund(refund: { order_id: string; refund_id: string; amount: number; created_at?: string }) {
  return post('/v1/refunds', refund);
}

export function cancelOrder(orderId: string) {
  return post(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {});
}

export interface BezzifySurvey {
  question: string;
  answers: { id: string; label: string }[];
}

/** Frage für die Danke Seite oder null, wenn sie aus ist. Ist Bezzify nicht erreichbar, fehlt sie eben, die Seite lädt trotzdem. */
export async function surveyQuestion(): Promise<BezzifySurvey | null> {
  const baseUrl = process.env.BEZZIFY_URL;
  const siteKey = process.env.BEZZIFY_SITE_KEY;
  if (!baseUrl || !siteKey) throw new Error('BEZZIFY_URL oder BEZZIFY_SITE_KEY fehlt');
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/survey?k=${encodeURIComponent(siteKey)}`, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const survey = (await response.json()) as { enabled: boolean } & Partial<BezzifySurvey>;
  return survey.enabled && survey.question && survey.answers ? { question: survey.question, answers: survey.answers } : null;
}

/** Antwort von der Danke Seite, orderId wie bei sendOrder */
export function sendSurveyAnswer(orderId: string, answer: string) {
  return post(`/v1/orders/${encodeURIComponent(orderId)}/survey`, { answer });
}
