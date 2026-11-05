import { isIP } from 'node:net';
import { sha256Hex } from './crypto.js';

const HEX64 = /^[a-f0-9]{64}$/;

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

/** Meta, Google, TikTok und Pinterest verlangen nur trim und Kleinschreibung */
export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@') || normalized.length < 5 || normalized.length > 254) return null;
  return normalized;
}

export function hashEmail(email: unknown): string | null {
  if (isSha256(email)) return email;
  const normalized = normalizeEmail(email);
  return normalized ? sha256Hex(normalized) : null;
}

/** Ziffern mit Ländervorwahl ohne +, wie die Conversion APIs sie erwarten, eine führende 0 gilt als nationale Nummer */
export function normalizePhone(phone: unknown, defaultCountryCode = '49'): string | null {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null;
  const text = String(phone).trim();
  const plus = text.startsWith('+');
  const international = plus || text.replace(/\D/g, '').startsWith('00');
  // In "+49 (0) 171 ..." ist die Null in Klammern die nationale Vorwahl und gehört nicht zur Nummer
  let digits = (international ? text.replace(/\(\s*0\s*\)/, '') : text).replace(/\D/g, '');
  if (!digits) return null;
  if (!plus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function hashPhone(phone: unknown, defaultCountryCode = '49'): string | null {
  if (isSha256(phone)) return phone;
  const normalized = normalizePhone(phone, defaultCountryCode);
  return normalized ? sha256Hex(normalized) : null;
}

/** TikTok hasht die Nummer mit Pluszeichen (E.164), aus einem fertigen Hash lässt sich das nicht ableiten */
export function hashPhoneE164(phone: unknown, defaultCountryCode = '49'): string | null {
  if (isSha256(phone)) return null;
  const normalized = normalizePhone(phone, defaultCountryCode);
  return normalized ? sha256Hex(`+${normalized}`) : null;
}

/** Kundennummer des Shops als stabiler Schlüssel, der nichts über den Kunden verrät */
export function customerKey(siteId: string, customerId: unknown): string | null {
  const id = normalizeExternalId(customerId);
  return id ? sha256Hex(`cust:${siteId}:${id}`) : null;
}

/** Shopify liefert IDs teils als GID (gid://shopify/OrderIdentity/123), Webhooks als Zahl */
export function normalizeExternalId(id: unknown): string | null {
  if (id === null || id === undefined) return null;
  const text = String(id).trim();
  if (!text) return null;
  const gid = text.match(/^gid:\/\/shopify\/\w+\/(\d+)/);
  if (gid) return gid[1];
  return text.slice(0, 128);
}

/** Drei Buchstaben in Großschrift oder null, andere Werte lassen Intl.NumberFormat im Dashboard scheitern */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : null;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ipv6Groups(ip: string): string[] {
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  if (tail === undefined) return left;
  const right = tail ? tail.split(':') : [];
  // eine eingebettete IPv4 Adresse am Ende belegt zwei Gruppen
  const width = right.length + (right.at(-1)?.includes('.') ? 1 : 0);
  return [...left, ...Array<string>(Math.max(0, 8 - left.length - width)).fill('0'), ...right];
}

/** Schlüssel für Rate Limits: ein Anschluss bekommt meist ein ganzes IPv6 /64, sonst wäre jede Adresse ein eigenes Limit */
export function rateLimitKey(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  if (isIP(ip) !== 6) return ip;
  return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`;
}

/** IPv4 auf /24, IPv6 auf /48 gekürzt, ungültige Adressen ergeben null */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) return `${v4.slice(0, v4.lastIndexOf('.'))}.0`;
  if (isIP(ip) !== 6) return null;
  return `${ipv6Groups(ip).slice(0, 3).join(':')}::`;
}

function isAndroidTablet(ua: string): boolean {
  // gleichwertig zu /Android(?!.*Mobile)/i, aber linear statt quadratisch bei langen Headern
  const lower = ua.toLowerCase();
  const android = lower.lastIndexOf('android');
  return android !== -1 && !lower.includes('mobile', android);
}

export function deviceFromUa(ua: string | null | undefined): 'mobile' | 'tablet' | 'desktop' {
  if (!ua) return 'desktop';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || isAndroidTablet(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
  return 'desktop';
}
