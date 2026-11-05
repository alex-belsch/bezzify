const formats = new Map<string, Intl.NumberFormat>();
function nf(key: string, opts: Intl.NumberFormatOptions) {
  let format = formats.get(key);
  if (!format) formats.set(key, (format = new Intl.NumberFormat('de-DE', opts)));
  return format;
}

/** Platzhalter für fehlende Werte */
export const NA = 'k. A.';

// Pixel und Bestell API nehmen beliebige drei Zeichen als Währung an, Intl wirft bei ungültigen Codes einen RangeError
const isCurrencyCode = (currency: string) => /^[A-Za-z]{3}$/.test(currency);

export function money(v: number | null | undefined, currency = 'EUR', digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  if (!isCurrencyCode(currency)) return `${nf(`n${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)} ${currency}`;
  return nf(`m${currency}${digits}`, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

export function moneyCompact(v: number, currency = 'EUR'): string {
  if (Number.isFinite(v) && Math.abs(v) >= 10_000 && isCurrencyCode(currency)) {
    return nf(`mc${currency}`, { style: 'currency', currency, notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(v);
  }
  return money(v, currency, 0);
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  return nf('int', { maximumFractionDigits: 0 }).format(v);
}

/** Attribuierte Bestellungen sind oft Bruchteile */
export function orders(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  const rounded = Math.round(v * 10) / 10;
  return nf(Number.isInteger(rounded) ? 'o0' : 'o1', { minimumFractionDigits: Number.isInteger(rounded) ? 0 : 1, maximumFractionDigits: 1 }).format(rounded);
}

export function ratio(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  return nf(`r${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  return nf(`p${digits}`, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

export function dateLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function dateTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone });
}

export function timeOnly(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone });
}

export function duration(days: number): string {
  if (!Number.isFinite(days)) return NA;
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))} Min.`;
  if (days < 1) return `${Math.round(days * 24)} Std.`;
  if (days < 1.5) return '1 Tag';
  return `${int(days)} Tage`;
}

export function channelColor(channel: string): string {
  return `var(--ch-${channel}, var(--ch-other_paid))`;
}

/** Liefert die Bezeichnung oder den Schlüssel selbst und ignoriert geerbte Felder wie __proto__ */
export function labelFor(labels: Record<string, string>, key: string): string {
  return Object.hasOwn(labels, key) ? labels[key] : key;
}
