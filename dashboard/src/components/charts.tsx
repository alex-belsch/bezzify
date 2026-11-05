import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Runde Achsenwerte in gleichen Schritten, die 0 und den Bereich von min bis max abdecken */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low === high) return [0, 1];
  const raw = (high - low) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const first = Math.floor(low / step + 1e-9);
  const last = Math.ceil(high / step - 1e-9);
  const ticks: number[] = [];
  // Vielfache statt Summen, toPrecision entfernt Reste wie 0.30000000000000004 auch bei sehr kleinen Schritten
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

export interface Series {
  key: string;
  label: string;
  color: string;
  area?: boolean;
}

interface LineChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: Series[];
  height?: number;
  formatY: (v: number) => string;
  formatValue: (v: number) => string;
  formatX: (x: string) => string;
}

export function LineChart({ data, xKey, series, height = 240, formatY, formatValue, formatX }: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 12, right: 108, bottom: 28, left: 64 };
  const w = Math.max(320, width);
  const iw = w - margin.left - margin.right;
  const ih = height - margin.top - margin.bottom;
  const valueAt = (i: number, key: string) => Number(data[i][key]) || 0;
  const values = data.flatMap((_, i) => series.map((s) => valueAt(i, s.key)));
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const bottom = ticks[0];
  const top = ticks[ticks.length - 1];
  const x = (i: number) => (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => ih - ((v - bottom) / (top - bottom)) * ih;
  const zeroY = y(0).toFixed(1);
  const anchor = (i: number) => (data.length > 1 && i === 0 ? 'start' : data.length > 1 && i === data.length - 1 ? 'end' : 'middle');

  const traces = series.map((s) => {
    const pts = data.map((_, i) => [x(i), y(valueAt(i, s.key))] as const);
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    const area = pts.length ? `${line}L${pts[pts.length - 1][0].toFixed(1)},${zeroY}L${pts[0][0].toFixed(1)},${zeroY}Z` : '';
    return { series: s, line, area, end: pts[pts.length - 1] };
  });
  const ends = traces.flatMap((t) => (t.end ? [{ series: t.series, x: t.end[0], y: t.end[1] }] : []));
  const endsFit = ends.length < 2 || Math.abs(ends[0].y - ends[1].y) >= 16;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 80))));

  // nach einem Wechsel auf einen kürzeren Zeitraum kann der alte Index hinter dem Ende liegen
  const active = hover !== null && hover >= 0 && hover < data.length ? hover : null;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = data.length <= 1 ? 0 : Math.round(((e.clientX - rect.left) / rect.width) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(data.length - 1, (h ?? -1) + 1));
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? data.length) - 1));
    if (e.key === 'Escape') setHover(null);
  };

  const tipLeft = active !== null ? margin.left + x(active) : 0;
  const flip = tipLeft > w - 220;

  return (
    <div className="chart" ref={ref}>
      <svg
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        role="img"
        aria-label={`Verlauf ${series.map((s) => s.label).join(' und ')}`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setHover((h) => h ?? data.length - 1)}
        onBlur={() => setHover(null)}
      >
        <g transform={`translate(${margin.left},${margin.top})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={iw} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? 'var(--baseline)' : 'var(--grid)' }} strokeWidth={1} />
              <text x={-10} y={y(t)} dy="0.32em" textAnchor="end">
                {formatY(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            // eine reguläre Beschriftung kurz vor dem letzten Tag würde sich mit dessen Beschriftung überlappen
            i === data.length - 1 || (i % labelEvery === 0 && data.length - 1 - i >= labelEvery) ? (
              <text key={String(d[xKey])} x={x(i)} y={ih + 18} textAnchor={anchor(i)}>
                {formatX(String(d[xKey]))}
              </text>
            ) : null,
          )}
          {traces.map((t) => (t.series.area ? <path key={`a-${t.series.key}`} d={t.area} style={{ fill: t.series.color, opacity: 0.1 }} /> : null))}
          {traces.map((t) => (
            <path key={t.series.key} d={t.line} fill="none" style={{ stroke: t.series.color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {/* ein einzelner Tag ergibt keine Linie, dann zeigt nur der Endpunkt den Wert */}
          {(endsFit || data.length === 1) &&
            ends.map((end) => (
              <g key={`e-${end.series.key}`}>
                <circle cx={end.x} cy={end.y} r={4} style={{ fill: end.series.color, stroke: 'var(--surface)' }} strokeWidth={2} />
                {endsFit && (
                  <text className="end-label" x={end.x + 10} y={end.y} dy="0.32em">
                    {end.series.label}
                  </text>
                )}
              </g>
            ))}
          {active !== null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={0} y2={ih} style={{ stroke: 'var(--baseline)' }} strokeWidth={1} />
              {series.map((s) => (
                <circle
                  key={s.key}
                  cx={x(active)}
                  cy={y(valueAt(active, s.key))}
                  r={4.5}
                  style={{ fill: s.color, stroke: 'var(--surface)' }}
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
          <rect
            x={0}
            y={0}
            width={iw}
            height={ih}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </g>
      </svg>
      {active !== null && (
        <div
          className="tooltip"
          style={{ top: margin.top + 4, left: flip ? undefined : tipLeft + 14, right: flip ? w - tipLeft + 14 : undefined }}
          role="status"
        >
          <div className="t-head">{formatX(String(data[active][xKey]))}</div>
          {series.map((s) => (
            <div className="t-row" key={s.key}>
              <span className="line-key" style={{ background: s.color }} />
              <strong>{formatValue(valueAt(active, s.key))}</strong>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; kind?: 'line' | 'dot' | 'ring' }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          {it.kind === 'line' ? (
            <i className="line-key" style={{ background: it.color }} />
          ) : it.kind === 'ring' ? (
            <i className="dot" style={{ border: `2px solid ${it.color}`, background: 'transparent' }} />
          ) : (
            <i className="dot" style={{ background: it.color }} />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

interface DumbbellRow {
  key: string;
  label: string;
  color: string;
  claimed: number;
  measured: number;
}

/** Plattform meldet (Ring) gegen Bezzify (Punkt) auf einer gemeinsamen Skala */
export function Dumbbell({ rows, format }: { rows: DumbbellRow[]; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const labelW = 120;
  const rightW = 150;
  const w = Math.max(360, width);
  const iw = w - labelW - rightW;
  const rowH = 38;
  const values = rows.flatMap((r) => [r.claimed, r.measured]);
  const ticks = niceTicks(Math.min(...values), Math.max(1, ...values), 4);
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  const x = (v: number) => ((v - low) / (high - low)) * iw;
  const h = rows.length * rowH + 26;
  return (
    <div className="chart" ref={ref}>
      <svg height={h} viewBox={`0 0 ${w} ${h}`} role="list" aria-label="Von Plattformen gemeldete gegen zugeordnete Werte">
        <g transform={`translate(${labelW},0)`} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={rows.length * rowH} style={{ stroke: t === 0 ? 'var(--baseline)' : 'var(--grid)' }} />
              <text x={x(t)} y={rows.length * rowH + 18} textAnchor="middle">
                {format(t)}
              </text>
            </g>
          ))}
        </g>
        {rows.map((row, i) => {
          const cy = i * rowH + rowH / 2;
          const diff = row.measured > 0 ? row.claimed / row.measured - 1 : null;
          const active = hover === row.key;
          return (
            <g
              key={row.key}
              role="listitem"
              tabIndex={0}
              onPointerEnter={() => setHover(row.key)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(row.key)}
              onBlur={() => setHover(null)}
              aria-label={`${row.label}: Plattform ${format(row.claimed)}, Bezzify ${format(row.measured)}`}
            >
              <rect x={0} y={i * rowH} width={w} height={rowH} style={{ fill: active ? 'var(--surface-2)' : 'transparent' }} />
              <text x={0} y={cy} dy="0.32em" style={{ fill: 'var(--ink)', fontSize: 13, fontWeight: 500 }}>
                {row.label}
              </text>
              <g transform={`translate(${labelW},0)`}>
                <line x1={x(Math.min(row.claimed, row.measured))} x2={x(Math.max(row.claimed, row.measured))} y1={cy} y2={cy} style={{ stroke: 'var(--baseline)' }} strokeWidth={2} />
                <circle cx={x(row.claimed)} cy={cy} r={6} style={{ fill: 'var(--surface)', stroke: row.color }} strokeWidth={2.5} />
                <circle cx={x(row.measured)} cy={cy} r={6} style={{ fill: row.color, stroke: 'var(--surface)' }} strokeWidth={2} />
              </g>
              <text x={labelW + iw + 16} y={cy} dy="0.32em" style={{ fill: 'var(--ink-2)', fontSize: 12.5 }}>
                {diff === null ? 'keine Zuordnung' : diff >= 0 ? `${Math.round(diff * 100)} % mehr gemeldet` : `${Math.round(-diff * 100)} % weniger gemeldet`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface BarRow {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function BarList({ rows, format }: { rows: BarRow[]; format: (v: number) => string }) {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: 12, alignItems: 'center' }}>
          <span className="secondary">{row.label}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'block',
                height: 12,
                width: `${Math.max(1, (row.value / max) * 82)}%`,
                background: row.color,
                borderRadius: '0 4px 4px 0',
              }}
            />
            <span className="num" style={{ fontWeight: 600 }}>
              {format(row.value)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TableToggle({ children, label = 'Werte als Tabelle' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="btn quiet small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Tabelle ausblenden' : label}
      </button>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}
