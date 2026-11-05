import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, errMsg, type Me, type SiteSettings } from './api';
import { niceTicks } from './components/charts';
import { NA, duration, labelFor, money, moneyCompact } from './format';
import { median } from './pages/Journeys';
import { answerId } from './pages/Setup';
import { addDays, initialFilters, loadMe, parseStoredFilters, todayIn } from './state';

// Intl trennt Zahl und Währung mit geschütztem Leerzeichen
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('Formatierung', () => {
  it('zeigt ungültige Währungscodes aus Shopdaten, statt mit RangeError abzustürzen', () => {
    expect(plain(money(12.5, '1E!', 2))).toBe('12,50 1E!');
    expect(plain(moneyCompact(25_000, 'EU '))).toBe('25.000 EU ');
    expect(plain(money(5, 'eur'))).toBe('5 €');
  });

  it('kürzt große Beträge ohne angehängtes ,0', () => {
    expect(plain(moneyCompact(12_345))).toBe('12.345 €');
    expect(plain(moneyCompact(2_000_000))).toBe('2 Mio. €');
    expect(plain(moneyCompact(1_234_567))).toBe('1,2 Mio. €');
    expect(moneyCompact(Number.NaN)).toBe(NA);
    expect(moneyCompact(Number.POSITIVE_INFINITY)).toBe(NA);
  });

  it('formatiert Dauern, auch ungültige und lange', () => {
    expect(duration(Number.NaN)).toBe(NA);
    expect(duration(Number.POSITIVE_INFINITY)).toBe(NA);
    expect(duration(0)).toBe('1 Min.');
    expect(duration(0.5)).toBe('12 Std.');
    expect(duration(1234.4)).toBe('1.234 Tage');
  });

  it('liefert für geerbte Schlüssel den Schlüssel selbst', () => {
    const labels = { page_view: 'Seitenaufruf' };
    expect(labelFor(labels, 'page_view')).toBe('Seitenaufruf');
    expect(labelFor(labels, '__proto__')).toBe('__proto__');
    expect(labelFor(labels, 'constructor')).toBe('constructor');
  });
});

describe('Achsenwerte', () => {
  it('bleibt für übliche Maxima bei den bisherigen Werten', () => {
    expect(niceTicks(0, 10_000)).toEqual([0, 2500, 5000, 7500, 10_000]);
    expect(niceTicks(0, 9000)).toEqual([0, 2500, 5000, 7500, 10_000]);
    expect(niceTicks(0, 1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('kommt mit Spannweite null, gleichen Werten und ungültigen Eingaben aus', () => {
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(5, 5)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(0, Number.POSITIVE_INFINITY)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN, Number.NaN)).toEqual([0, 1]);
  });

  it('deckt negative Werte ab und enthält immer die 0', () => {
    expect(niceTicks(-300, 1000)).toEqual([-500, 0, 500, 1000]);
    expect(niceTicks(-5, -5)).toEqual([-6, -4, -2, 0]);
  });

  it('liefert bei sehr kleinen Werten eindeutige Ticks bis über das Maximum', () => {
    const ticks = niceTicks(0, 0.0001);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(0.0001);
    expect(niceTicks(0, 0.01)).toEqual([0, 0.0025, 0.005, 0.0075, 0.01]);
  });
});

describe('Journeys', () => {
  it('berechnet den Median auch bei gerader Anzahl', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

const settings = { attributionModel: 'last_non_direct', windowDays: null, ignoreDirect: true } as SiteSettings;
const me = {
  sites: [{ id: 'site_a', timezone: 'Europe/Berlin', settings }],
  models: [{ id: 'last_non_direct', label: 'Letzter Klick ohne Direkt' }, { id: 'linear', label: 'Linear' }],
} as Me;

describe('Gespeicherte Filter', () => {
  it('verwirft kaputtes, fremdes und falsch typisiertes JSON', () => {
    expect(parseStoredFilters(null)).toEqual({});
    expect(parseStoredFilters('null')).toEqual({});
    expect(parseStoredFilters('[1,2]')).toEqual({});
    expect(parseStoredFilters('{kaputt')).toEqual({});
    const mixed = '{"__proto__":{"siteId":"x"},"preset":"jahr","from":"gestern","ignoreDirect":"ja","model":"linear"}';
    expect(parseStoredFilters(mixed)).toEqual({ model: 'linear' });
  });

  it('übernimmt das unbegrenzte Fenster der Shopeinstellung', () => {
    expect(initialFilters(me, {}).window).toBe('unlimited');
    const sevenDays = { ...me, sites: [{ ...me.sites[0], settings: { ...settings, windowDays: 7 } }] } as Me;
    expect(initialFilters(sevenDays, {}).window).toBe('7');
    expect(initialFilters(me, { window: '30' }).window).toBe('30');
  });

  it('fällt bei unbekanntem Modell und vertauschtem Zeitraum auf Standardwerte zurück', () => {
    const filters = initialFilters(me, { model: 'entfernt', preset: 'custom', from: '2026-05-10', to: '2026-05-01' });
    expect(filters.model).toBe('last_non_direct');
    expect(filters.to).toBe(todayIn('Europe/Berlin'));
    expect(filters.from).toBe(addDays(filters.to, -29));
    expect(initialFilters(me, { model: 'linear' }).model).toBe('linear');
  });
});

describe('API', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('meldet einen nicht erreichbaren Server auf Deutsch, lässt Abbrüche aber durch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api('/me')).rejects.toMatchObject({ status: 0, message: 'Server nicht erreichbar' });

    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('abgebrochen', 'AbortError'))));
    await expect(api('/me', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('macht aus einer erfolgreichen Antwort ohne JSON keinen leeren Datensatz', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>Proxy</title>', { status: 200 })));
    await expect(api('/journeys')).rejects.toMatchObject({ status: 200, message: 'Antwort des Servers ist kein JSON' });
  });

  it('hängt den ersten Prüffehler an die Meldung', async () => {
    vi.stubGlobal('fetch', respond(400, { error: 'Ungültige Eingabe', issues: [{ path: ['settings', 'windowDays'], message: 'zu groß' }] }));
    await expect(api('/sites/x', { method: 'PUT', body: {} })).rejects.toMatchObject({
      status: 400,
      message: 'Ungültige Eingabe: settings.windowDays zu groß',
    });
  });

  it('wertet nur 401 als abgemeldet, andere Fehler beim Laden von /me bleiben sichtbar', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('fetch', respond(401, { error: 'Nicht angemeldet' }));
    await expect(loadMe()).resolves.toBeNull();

    vi.stubGlobal('fetch', respond(500, { error: 'Interner Fehler' }));
    const err = await loadMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(errMsg(err)).toBe('Interner Fehler');
    expect(errMsg('kein Error Objekt')).toBe('kein Error Objekt');
  });
});

describe('Umfrage', () => {
  it('bildet Kennungen neuer Antworten aus der Beschriftung, ohne doppelte', () => {
    expect(answerId('Über Freunde & Familie', new Set())).toBe('ueber_freunde_familie');
    expect(answerId('TikTok', new Set(['tiktok', 'tiktok_2']))).toBe('tiktok_3');
    expect(answerId('!!!', new Set())).toBe('antwort');
  });
});
