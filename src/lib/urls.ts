// Mailadressen, Zugangsdaten und ohne Einwilligung jede Kennung haben in gespeicherten URLs nichts verloren
const SENSITIVE_KEYS = new Set([
  'email',
  'e-mail',
  'mail',
  'phone',
  'tel',
  'telefon',
  'mobile',
  'password',
  'passwort',
  'pass',
  'pwd',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth',
  'key',
  'api_key',
  'apikey',
  'secret',
  'reset_key',
  'reset_token',
  'session',
  'sessionid',
  'session_id',
  'sid',
]);

const CAMPAIGN_PARAM = /^(utm_[a-z_]+|bzf_[a-z]+|gad_campaignid|gad_source)$/i;
const DELIMITER = /[\s@/?&=#]/;

export function parseUrl(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function hostOf(url: string | null | undefined): string | null {
  const parsed = parseUrl(url);
  return parsed ? parsed.hostname.toLowerCase().replace(/^www\./, '') : null;
}

/** Läuft linear über die Zeichen statt mit einem rückverfolgenden Muster, die Eingabe kommt aus dem Internet */
export function containsEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let at = value.indexOf('@');
  while (at !== -1) {
    if (at > 0 && !DELIMITER.test(value[at - 1])) {
      let end = at + 1;
      while (end < value.length && !DELIMITER.test(value[end])) end++;
      if (/\.[a-z]{2,}/i.test(value.slice(at + 1, end))) return true;
    }
    at = value.indexOf('@', at + 1);
  }
  return false;
}

export function withoutEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  return containsEmail(value) ? null : value;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function stripPathEmails(url: URL) {
  if (!url.pathname.includes('@') && !/%40/i.test(url.pathname)) return;
  url.pathname = url.pathname
    .split('/')
    .map((segment) => (containsEmail(decodeSegment(segment)) ? '(email)' : segment))
    .join('/');
}

function sanitize(url: string | null | undefined, max: number, dropKey: (key: string) => boolean): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  stripPathEmails(parsed);
  for (const key of new Set(parsed.searchParams.keys())) {
    if (dropKey(key) || parsed.searchParams.getAll(key).some(containsEmail)) parsed.searchParams.delete(key);
  }
  return parsed.toString().slice(0, max);
}

/** Mit Einwilligung: Adresse behalten, aber Zugangsdaten und Kontaktdaten im Klartext entfernen */
export function scrubUrl(url: string | null | undefined, max = 2048): string | null {
  return sanitize(url, max, (key) => SENSITIVE_KEYS.has(key.toLowerCase()));
}

/** Ohne Einwilligung: nur UTM und bzf Parameter, keine Klick IDs und keine anderen Kennungen */
export function anonymousUrl(url: string | null | undefined, max = 2048): string | null {
  return sanitize(url, max, (key) => !CAMPAIGN_PARAM.test(key));
}

/** Nur Herkunft, z.B. https://www.google.com/ */
export function originOnly(url: string | null | undefined): string | null {
  const parsed = parseUrl(url);
  return parsed && parsed.origin !== 'null' ? `${parsed.origin}/` : null;
}
