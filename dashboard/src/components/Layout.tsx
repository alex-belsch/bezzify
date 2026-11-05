import type { ReactNode } from 'react';
import { api, errMsg } from '../api';
import { presetRange, useApp, type Preset } from '../state';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 20) / 28} viewBox="0 0 28 20" aria-hidden="true">
      <path d="M2 14h22" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M2 14c8 0 9-8 17-8h5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <circle cx="24.5" cy="14" r="2.6" fill="currentColor" />
      <circle cx="24.5" cy="6" r="2.6" fill="currentColor" />
    </svg>
  );
}

const NAV = [
  { path: '/', label: 'Übersicht' },
  { path: '/kampagnen', label: 'Kampagnen' },
  { path: '/journeys', label: 'Journeys' },
  { path: '/modelle', label: 'Modelle' },
  { path: '/live', label: 'Live' },
  { path: '/einrichtung', label: 'Einrichtung' },
];

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  const { me, toast } = useApp();
  const logout = async () => {
    try {
      await api('/logout', { method: 'POST' });
    } catch (err) {
      // das Sessioncookie ist httpOnly, ohne Antwort des Servers bleibt die Anmeldung bestehen
      toast(`Abmelden fehlgeschlagen: ${errMsg(err)}`);
      return;
    }
    window.dispatchEvent(new Event('bezzify:logout'));
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <Logo />
          <span className="brand-name">Bezzify</span>
        </a>
        <nav className="nav" aria-label="Bereiche">
          {NAV.map((n) => (
            <a key={n.path} href={`#${n.path}`} aria-current={route === n.path ? 'page' : undefined}>
              <span className="station" aria-hidden="true" />
              {n.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>{me.user.email}</span>
          <button className="btn quiet small" onClick={logout} type="button">
            Abmelden
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: 'Heute' },
  { id: '7', label: '7 Tage' },
  { id: '30', label: '30 Tage' },
  { id: '90', label: '90 Tage' },
  { id: 'month', label: 'Dieser Monat' },
  { id: 'custom', label: 'Eigener' },
];

const WINDOWS = [
  ['1', '1 Tag'],
  ['7', '7 Tage'],
  ['14', '14 Tage'],
  ['30', '30 Tage'],
  ['60', '60 Tage'],
  ['90', '90 Tage'],
  ['unlimited', 'Unbegrenzt'],
];

export function FilterBar({ showModel = true }: { showModel?: boolean }) {
  const { me, site, filters, setFilters } = useApp();
  return (
    <div className="filters" role="group" aria-label="Filter">
      {me.sites.length > 1 && (
        <label className="field">
          Shop
          <select value={site.id} onChange={(e) => setFilters({ siteId: e.target.value })}>
            {me.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="segmented" role="group" aria-label="Zeitraum">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={filters.preset === preset.id}
            onClick={() => setFilters({ preset: preset.id, ...presetRange(preset.id, site.timezone, { from: filters.from, to: filters.to }) })}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {filters.preset === 'custom' && (
        <>
          <label className="field">
            Von
            <input type="date" value={filters.from} max={filters.to} onChange={(e) => e.target.value && setFilters({ from: e.target.value })} />
          </label>
          <label className="field">
            Bis
            <input type="date" value={filters.to} min={filters.from} onChange={(e) => e.target.value && setFilters({ to: e.target.value })} />
          </label>
        </>
      )}
      {showModel && (
        <>
          <label className="field">
            Modell
            <select value={filters.model} onChange={(e) => setFilters({ model: e.target.value })}>
              {me.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Fenster
            <select value={filters.window} onChange={(e) => setFilters({ window: e.target.value })}>
              {WINDOWS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <details className="options">
            <summary>Optionen</summary>
            <div className="popover">
              <label className="check">
                <input type="checkbox" checked={filters.ignoreDirect} onChange={(e) => setFilters({ ignoreDirect: e.target.checked })} />
                Direktzugriffe ignorieren, wenn es andere Touchpoints gibt
              </label>
              <label className="check">
                <input type="checkbox" checked={filters.extrapolate} onChange={(e) => setFilters({ extrapolate: e.target.checked })} />
                Käufe ohne Einwilligung anteilig hochrechnen
              </label>
              <div className="form-row">
                <label htmlFor="basis">Attributionsdatum</label>
                <select id="basis" value={filters.basis} onChange={(e) => setFilters({ basis: e.target.value as 'conversion' | 'touch' })}>
                  <option value="conversion">Kaufdatum</option>
                  <option value="touch">Datum des Touchpoints</option>
                </select>
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export function PageHead({ title, intro, actions }: { title: string; intro?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {intro && <p>{intro}</p>}
      </div>
      {actions}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      {error}
    </div>
  );
}
