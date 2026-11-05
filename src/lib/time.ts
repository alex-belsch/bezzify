const partsFormats = new Map<string, Intl.DateTimeFormat>();
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(tz: string): Intl.DateTimeFormat {
  let format = partsFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormats.set(tz, format);
  }
  return format;
}

function dayFormat(tz: string): Intl.DateTimeFormat {
  let format = dayFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(tz, format);
  }
  return format;
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Abstand der Zeitzone zu UTC zum Zeitpunkt utcMs, positiv östlich von UTC */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = partsFormat(tz).formatToParts(new Date(utcMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Erster Zeitpunkt des Kalendertags (YYYY-MM-DD) in der Zeitzone */
export function zonedStartOfDay(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  const first = midnight - tzOffsetMs(midnight, tz);
  const second = midnight - tzOffsetMs(first, tz);
  // Beginnt die Sommerzeit um Mitternacht (Chile, Kuba), liegt einer der beiden Kandidaten noch auf dem Vortag
  const onDay = [first, second].filter((ts) => zonedDay(ts, tz) === day);
  return new Date(onDay.length ? Math.min(...onDay) : second);
}

export function zonedDay(date: Date | number, tz: string): string {
  return dayFormat(tz).format(typeof date === 'number' ? new Date(date) : date);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// gut zehn Jahre, mehr wertet niemand tageweise aus
const MAX_DAY_LIST = 3700;

export function dayList(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_DAY_LIST) break;
  }
  return days;
}

export function isDay(value: unknown): value is string {
  // Date.parse nimmt auch den 30. Februar an, erst der Rückweg über addDays zeigt ungültige Tage
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && addDays(value, 0) === value;
}

/** "2026-11-04 15:30:00+01:00" für den Google Ads Upload */
export function googleDateTime(date: Date, tz: string): string {
  const offset = tzOffsetMs(date.getTime(), tz);
  const local = new Date(date.getTime() + offset).toISOString().slice(0, 19).replace('T', ' ');
  const offsetMinutes = Math.abs(offset) / 60_000;
  const hh = String(Math.floor(offsetMinutes / 60)).padStart(2, '0');
  const mm = String(offsetMinutes % 60).padStart(2, '0');
  return `${local}${offset >= 0 ? '+' : '-'}${hh}:${mm}`;
}
