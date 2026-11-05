import { ChannelKey } from '../components/Copy';
import { useWidth } from '../components/charts';
import { ErrorNote, PageHead } from '../components/Layout';
import { int, labelFor, money, timeOnly } from '../format';
import { useApi, useApp } from '../state';

interface LiveRes {
  active: number;
  perMinute: { minute: string; n: number }[];
  events: { name: string; ts: string; path: string; visitor: string | null; channel: string | null; label: string | null; device: string | null; campaign: string | null }[];
  orders: { external_id: string; order_number: string | null; created_at: string; total: number; currency: string; source: string; linked: boolean; is_test: boolean }[];
}

const EVENT_LABELS: Record<string, string> = {
  page_view: 'Seitenaufruf',
  view_item: 'Produkt angesehen',
  add_to_cart: 'In den Warenkorb',
  begin_checkout: 'Checkout begonnen',
  identify: 'Identifiziert',
  purchase: 'Kauf',
};

const SOURCE_LABELS: Record<string, string> = { pixel: 'Pixel', webhook: 'Webhook', api: 'Server API' };

export function LivePage() {
  const { site } = useApp();
  const { data, error } = useApi<LiveRes>(`/live?site=${site.id}`, { refreshMs: 5000 });
  return (
    <>
      <PageHead title="Live" intro="Eingehende Events der letzten Minuten. Gut zum Prüfen, ob das Tracking nach der Einrichtung ankommt." />
      <ErrorNote error={error} />
      {data && (
        <div className="stack">
          <section className="hero" aria-label="Aktive Besucher">
            <div className="hero-figure">
              <span className="label">Besucher gerade aktiv</span>
              <span className="value">{int(data.active)}</span>
              <span className="sub">mit Events in den letzten 5 Minuten</span>
            </div>
            <div style={{ padding: '18px 20px' }}>
              <p className="secondary" style={{ marginBottom: 8 }}>
                Events pro Minute, letzte 30 Minuten
              </p>
              <MinuteBars perMinute={data.perMinute} timeZone={site.timezone} />
            </div>
          </section>
          <div className="two-col">
            <section className="panel">
              <div className="panel-head">
                <h2>Events</h2>
                <p>aktualisiert alle 5 Sekunden</p>
              </div>
              {data.events.length === 0 ? (
                <div className="empty">
                  <p>Noch keine Events. Prüfe unter Einrichtung, ob das Skript oder Pixel eingebunden ist und die Einwilligung erteilt wurde.</p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Zeit</th>
                        <th style={{ textAlign: 'left' }}>Event</th>
                        <th style={{ textAlign: 'left' }}>Seite</th>
                        <th style={{ textAlign: 'left' }}>Kanal</th>
                        <th>Besucher</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.events.map((event, i) => (
                        <tr key={i}>
                          <td>{timeOnly(event.ts, site.timezone)}</td>
                          <td style={{ textAlign: 'left' }}>{labelFor(EVENT_LABELS, event.name)}</td>
                          <td style={{ textAlign: 'left', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={event.path}>
                            {event.path}
                          </td>
                          <td style={{ textAlign: 'left' }}>{event.channel ? <ChannelKey channel={event.channel} label={event.label ?? event.channel} /> : null}</td>
                          <td className="secondary">{event.visitor}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Letzte Bestellungen</h2>
              </div>
              {data.orders.length === 0 ? (
                <p className="muted">Noch keine Bestellungen.</p>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Bestellung</th>
                      <th>Betrag</th>
                      <th>Quelle</th>
                      <th>Journey</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map((order) => (
                      <tr key={order.external_id}>
                        <td>
                          {order.order_number ?? order.external_id}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {timeOnly(order.created_at, site.timezone)}
                            {order.is_test ? ', Test' : ''}
                          </div>
                        </td>
                        <td>{money(order.total, order.currency, 2)}</td>
                        <td>{labelFor(SOURCE_LABELS, order.source)}</td>
                        <td>
                          {order.linked ? (
                            <span className="badge ok">
                              <span className="status-icon" aria-hidden="true">
                                ✓
                              </span>
                              verknüpft
                            </span>
                          ) : (
                            <span className="badge">ohne</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}

function MinuteBars({ perMinute, timeZone }: { perMinute: LiveRes['perMinute']; timeZone: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const now = Date.now();
  const buckets = Array.from({ length: 30 }, (_, i) => {
    const start = new Date(Math.floor((now - (29 - i) * 60_000) / 60_000) * 60_000);
    const hit = perMinute.find((d) => Math.abs(new Date(d.minute).getTime() - start.getTime()) < 30_000);
    return { start, n: hit?.n ?? 0 };
  });
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const h = 88;
  const w = Math.max(240, width);
  const slot = w / buckets.length;
  const bw = Math.min(14, slot - 2);
  return (
    <div className="chart" ref={ref}>
      <svg height={h + 18} viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label="Events pro Minute">
        <line x1={0} x2={w} y1={h} y2={h} style={{ stroke: 'var(--baseline)' }} />
        {buckets.map((bucket, i) => {
          const bh = Math.max(4, (bucket.n / max) * (h - 6));
          const x = i * slot + (slot - bw) / 2;
          return (
            <g key={i}>
              <title>{`${bucket.start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone })}: ${bucket.n} Events`}</title>
              {bucket.n > 0 && (
                <path
                  d={`M${x},${h}V${h - bh + 3}q0,-3 3,-3h${bw - 6}q3,0 3,3V${h}Z`}
                  style={{ fill: 'var(--accent)' }}
                />
              )}
            </g>
          );
        })}
        <text x={0} y={h + 14}>
          vor 30 Min.
        </text>
        <text x={w} y={h + 14} textAnchor="end">
          jetzt
        </text>
      </svg>
    </div>
  );
}
