import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, errMsg, type Me, type SiteInfo } from './api';

export type Preset = 'today' | '7' | '30' | '90' | 'month' | 'custom';

export interface Filters {
  siteId: string;
  preset: Preset;
  from: string;
  to: string;
  model: string;
  window: string;
  basis: 'conversion' | 'touch';
  ignoreDirect: boolean;
  extrapolate: boolean;
}

interface Ctx {
  me: Me;
  site: SiteInfo;
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  query: string;
  reloadMe: () => Promise<void>;
  toast: (msg: string) => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('AppCtx fehlt');
  return ctx;
}

export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function presetRange(preset: Preset, timeZone: string, current?: { from: string; to: string }) {
  const today = todayIn(timeZone);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case '7':
      return { from: addDays(today, -6), to: today };
    case '90':
      return { from: addDays(today, -89), to: today };
    case 'month':
      return { from: today.slice(0, 8) + '01', to: today };
    case 'custom':
      return current ?? { from: addDays(today, -29), to: today };
    default:
      return { from: addDays(today, -29), to: today };
  }
}

const STORE_KEY = 'bezzify:filters';
const PRESETS: readonly Preset[] = ['today', '7', '30', '90', 'month', 'custom'];

const isDay = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const isString = (value: unknown) => typeof value === 'string';
const isBoolean = (value: unknown) => typeof value === 'boolean';

const STORED_FIELDS: { [K in keyof Filters]: (value: unknown) => boolean } = {
  siteId: isString,
  preset: (value) => PRESETS.includes(value as Preset),
  from: isDay,
  to: isDay,
  model: isString,
  window: isString,
  basis: (value) => value === 'conversion' || value === 'touch',
  ignoreDirect: isBoolean,
  extrapolate: isBoolean,
};

export function parseStoredFilters(raw: string | null): Partial<Filters> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(([key, value]) => Object.hasOwn(STORED_FIELDS, key) && STORED_FIELDS[key as keyof Filters](value)),
  );
}

function loadStoredFilters(): Partial<Filters> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    return {};
  }
  return parseStoredFilters(raw);
}

function saveFilters(filters: Filters) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(filters));
  } catch {
    // ohne Speicher (privater Modus, Kontingent voll) gelten die Filter bis zum Neuladen
  }
}

export function initialFilters(me: Me, stored: Partial<Filters>): Filters {
  const site = me.sites.find((s) => s.id === stored.siteId) ?? me.sites[0];
  const { attributionModel, windowDays, ignoreDirect } = site.settings;
  const preset = stored.preset ?? '30';
  const range = stored.from && stored.to && stored.from <= stored.to ? { from: stored.from, to: stored.to } : undefined;
  return {
    siteId: site.id,
    preset,
    ...presetRange(preset, site.timezone, range),
    model: stored.model && me.models.some((m) => m.id === stored.model) ? stored.model : attributionModel,
    window: stored.window ?? (windowDays === null ? 'unlimited' : String(windowDays)),
    basis: stored.basis ?? 'conversion',
    ignoreDirect: stored.ignoreDirect ?? ignoreDirect,
    extrapolate: stored.extrapolate ?? false,
  };
}

export function AppProvider({ me, children, reloadMe }: { me: Me; children: ReactNode; reloadMe: () => Promise<void> }) {
  const [filters, setFiltersState] = useState<Filters>(() => initialFilters(me, loadStoredFilters()));
  const [toastNote, setToastNote] = useState<{ text: string } | null>(null);
  const site = me.sites.find((s) => s.id === filters.siteId) ?? me.sites[0];

  useEffect(() => saveFilters(filters), [filters]);

  useEffect(() => {
    if (!toastNote) return;
    const timer = window.setTimeout(() => setToastNote(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toastNote]);

  const setFilters = useCallback((patch: Partial<Filters>) => setFiltersState((current) => ({ ...current, ...patch })), []);
  const toast = useCallback((text: string) => setToastNote({ text }), []);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      site: site.id,
      from: filters.from,
      to: filters.to,
      model: filters.model,
      window: filters.window,
      basis: filters.basis,
      ignoreDirect: filters.ignoreDirect ? '1' : '0',
      extrapolate: filters.extrapolate ? '1' : '0',
    });
    return params.toString();
  }, [site.id, filters]);

  const ctx = useMemo(() => ({ me, site, filters, setFilters, query, reloadMe, toast }), [me, site, filters, setFilters, query, reloadMe, toast]);

  return (
    <AppCtx.Provider value={ctx}>
      {children}
      <div role="status">{toastNote && <div className="toast">{toastNote.text}</div>}</div>
    </AppCtx.Provider>
  );
}

/** Lädt Daten und behält beim Neuladen die alte Ansicht (abgeblendet) */
export function useApi<T>(path: string | null, { refreshMs }: { refreshMs?: number } = {}) {
  const [loaded, setLoaded] = useState<{ path: string; payload: T } | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    // abbrechen statt nur ignorieren, damit bei schnellen Filterwechseln keine alten Anfragen die Verbindungen belegen
    const controller = new AbortController();
    setLoading(true);
    api<T>(path, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setLoaded({ path, payload });
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // nur Daten derselben Abfrage behalten, sonst stünden nach einem Filterwechsel alte Zahlen als aktuell da
        setLoaded((current) => (current?.path === path ? current : undefined));
        setError(errMsg(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, tick]);

  // nächste Abfrage erst nach der Antwort planen, sonst bricht jede Runde eine langsame Anfrage ab
  useEffect(() => {
    if (!refreshMs || loading) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), refreshMs);
    return () => window.clearTimeout(timer);
  }, [refreshMs, loading]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: loaded?.payload, error, loading, reload };
}

function readHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path: path || '/', qs: qs ?? '' };
}

export function useHashRoute(): [string, URLSearchParams] {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const onHashChange = () => setRoute(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const params = useMemo(() => new URLSearchParams(route.qs), [route.qs]);
  return [route.path, params];
}

export function navigate(path: string) {
  window.location.hash = path;
}

/** null heißt nicht angemeldet, andere Fehler (Server nicht erreichbar, 500) werden geworfen */
export async function loadMe(): Promise<Me | null> {
  try {
    return await api<Me>('/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}
