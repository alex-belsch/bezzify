import { useState } from 'react';
import type { JourneyOrder, JourneyTouch } from '../api';
import { channelColor, dateTime, duration, money, pct } from '../format';
import { useWidth } from './charts';

/** Platz links für die mittig gesetzte Beschriftung der ersten Station */
const LEFT = 64;
const RIGHT = 40;
const MIN_STEP = 104;
const MAX_STEP = 150;

/** Zeigt eine Journey als Gleis mit einer Station je Touchpoint und dem Kauf als Endstation, darunter der Anteil laut Modell */
export function JourneyRoute({ order, currency, timeZone }: { order: JourneyOrder; currency: string; timeZone: string }) {
  const [focus, setFocus] = useState<number | null>(null);
  const [ref, available] = useWidth<HTMLDivElement>();
  const stations = order.touches.length;
  const step = Math.max(MIN_STEP, Math.min(MAX_STEP, (Math.max(available, 300) - LEFT - RIGHT) / Math.max(1, stations)));
  const end = LEFT + stations * step;
  const width = end + RIGHT;
  const height = 92;
  const trackY = 34;
  const purchaseTs = Date.parse(order.createdAt);

  const gapLabel = (i: number) => {
    // Touchpoints aus den Shopdaten haben keinen echten Zeitpunkt
    if (order.touches[i].fromShop) return '';
    const since = Date.parse(order.touches[i].ts);
    const until = i + 1 < stations ? Date.parse(order.touches[i + 1].ts) : purchaseTs;
    return duration(Math.max(0, until - since) / 86_400_000);
  };

  const tip = focus !== null ? order.touches[focus] : null;
  const status = order.isNew === null ? 'Kundenstatus unbekannt' : order.isNew ? 'Neukunde' : 'Bestandskunde';

  return (
    <div className="route">
      <div className="route-meta">
        <span className="order">{order.orderNumber ?? order.externalId}</span>
        <span className="value">{money(order.revenue, currency, 2)}</span>
        <span className="sub">{order.refunded ? `${status}, erstattet` : status}</span>
        <span className="sub">{dateTime(order.createdAt, timeZone)}</span>
      </div>
      <div className="track" ref={ref}>
        {stations === 0 ? (
          <p className="muted" style={{ paddingTop: 22 }}>
            Kein Touchpoint bekannt. Meist fehlt die Einwilligung für das Tracking.
          </p>
        ) : (
          <svg width={width} height={height} role="list" aria-label={`Journey der Bestellung ${order.orderNumber ?? order.externalId}`}>
            <line x1={LEFT} x2={end} y1={trackY} y2={trackY} style={{ stroke: 'var(--baseline)' }} strokeWidth={2} strokeLinecap="round" />
            {order.touches.map((touch, i) => {
              const cx = LEFT + i * step;
              const credited = touch.share > 0.0005;
              const color = channelColor(touch.channel);
              const maxChars = Math.floor(step / 7.2);
              return (
                <g key={i}>
                  <text x={cx + step / 2} y={trackY - 12} textAnchor="middle" style={{ fill: 'var(--muted)', fontSize: 11.5 }}>
                    {gapLabel(i)}
                  </text>
                  <g
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${touch.label}${touch.campaign ? `, ${touch.campaign}` : ''}, Anteil ${pct(touch.share)}`}
                    onPointerEnter={() => setFocus(i)}
                    onPointerLeave={() => setFocus(null)}
                    onFocus={() => setFocus(i)}
                    onBlur={() => setFocus(null)}
                  >
                    <circle cx={cx} cy={trackY} r={16} fill="transparent" />
                    <circle
                      cx={cx}
                      cy={trackY}
                      r={7}
                      style={credited ? { fill: color, stroke: 'var(--surface)' } : { fill: 'var(--surface)', stroke: color }}
                      strokeWidth={credited ? 2 : 2.5}
                    />
                    <text x={cx} y={trackY + 26} textAnchor="middle" style={{ fill: credited ? 'var(--ink)' : 'var(--muted)', fontSize: 12.5, fontWeight: 500 }}>
                      {touch.label.length > maxChars ? `${touch.label.slice(0, maxChars - 1)}…` : touch.label}
                    </text>
                    <text x={cx} y={trackY + 42} textAnchor="middle" style={{ fill: 'var(--ink-2)', fontSize: 12 }} className="num">
                      {touch.fromShop ? 'aus Shopdaten' : pct(touch.share)}
                    </text>
                  </g>
                </g>
              );
            })}
            <g aria-label={`Kauf, ${money(order.revenue, currency, 2)}`} role="listitem">
              <rect x={end - 8} y={trackY - 8} width={16} height={16} rx={3} style={{ fill: 'var(--ink)', stroke: 'var(--surface)' }} strokeWidth={2} />
              <text x={end} y={trackY + 26} textAnchor="middle" style={{ fill: 'var(--ink)', fontSize: 12.5, fontWeight: 600 }}>
                Kauf
              </text>
            </g>
          </svg>
        )}
        {tip && focus !== null && <StationTip touch={tip} left={LEFT + focus * step} timeZone={timeZone} />}
      </div>
    </div>
  );
}

function StationTip({ touch, left, timeZone }: { touch: JourneyTouch; left: number; timeZone: string }) {
  const device = touch.device === 'mobile' ? 'Smartphone' : touch.device === 'tablet' ? 'Tablet' : touch.device ? 'Computer' : null;
  return (
    <div className="tooltip" style={{ top: 60, left: Math.max(0, left - 24) }} role="status">
      <div className="t-head">{touch.fromShop ? 'Landing Page aus den Bestelldaten' : dateTime(touch.ts, timeZone)}</div>
      <div className="t-row">
        <span className="dot" style={{ background: channelColor(touch.channel) }} />
        <strong>{pct(touch.share, touch.share > 0 && touch.share < 0.1 ? 1 : 0)}</strong>
        <span>{touch.label}</span>
      </div>
      {touch.campaign && <div className="secondary">Kampagne {touch.campaign}</div>}
      {touch.source && <div className="secondary">Quelle {touch.source}</div>}
      {device && <div className="secondary">Gerät {device}</div>}
    </div>
  );
}
