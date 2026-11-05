import { useMemo, useState, type MouseEvent } from 'react';
import type { ExtrapolationInfo, Overview, Row } from '../api';
import { ChannelKey } from '../components/Copy';
import { Dumbbell, Legend, LineChart, TableToggle } from '../components/charts';
import { ErrorNote, FilterBar, PageHead } from '../components/Layout';
import { SortHead, sortRows, type Sort } from '../components/SortHead';
import { NA, channelColor, dateLabel, int, money, moneyCompact, orders, pct, ratio } from '../format';
import { navigate, useApi, useApp } from '../state';

type SortKey = 'label' | 'spend' | 'sessions' | 'orders' | 'revenue' | 'roas' | 'cpa' | 'newOrders';

export function OverviewPage() {
  const { site, query, me, filters } = useApp();
  const { data, error, loading } = useApi<Overview>(`/report/overview?${query}`);
  const [sort, setSort] = useState<Sort<SortKey>>({ key: 'revenue', dir: -1 });
  const [metric, setMetric] = useState<'orders' | 'revenue'>('orders');
  const currency = site.currency;
  const modelLabel = me.models.find((m) => m.id === filters.model)?.label ?? filters.model;
  const kpis = data?.kpis;

  const channelRows = useMemo(() => (data ? sortRows(data.channels, sort) : []), [data, sort]);
  const totalRevenue = data ? data.channels.reduce((s, r) => s + r.revenue, 0) : 0;

  return (
    <>
      <PageHead title="Übersicht" intro={`${site.name}, Zuordnung nach ${modelLabel}`} />
      <FilterBar />
      <ErrorNote error={error} />
      {data && kpis && (
        <div className="loading-frame stack" data-loading={loading}>
          <section className="hero" aria-label="Kennzahlen">
            <div className="hero-figure">
              <span className="label">Umsatz</span>
              <span className="value">{money(kpis.revenue, currency)}</span>
              <span className="sub">
                {int(kpis.orders)} Bestellungen, {money(kpis.aov, currency, 2)} je Bestellung
              </span>
            </div>
            <div className="kpis">
              <Kpi label="Werbekosten" value={money(kpis.spend, currency)} sub="inklusive manueller Kosten" />
              <Kpi label="MER" value={ratio(kpis.mer)} sub="Gesamtumsatz durch Werbekosten" />
              <Kpi label="ROAS bezahlte Kanäle" value={ratio(kpis.paidRoas)} sub={`${money(kpis.paidRevenue, currency)} zugeordnet`} />
              <Kpi label="Neukunden" value={int(kpis.newOrders)} sub={`${pct(kpis.newShare)} der Bestellungen`} />
              <Kpi label="Kosten je Neukunde" value={money(kpis.cac, currency, 2)} sub="Werbekosten durch Neukunden" />
              <Kpi label="Tracking Abdeckung" value={pct(kpis.coverage)} sub={`${int(kpis.trackedOrders)} von ${int(kpis.orders)} Bestellungen mit Journey`} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Umsatz und Werbekosten pro Tag</h2>
              <Legend
                items={[
                  { label: 'Umsatz', color: 'var(--accent)', kind: 'line' },
                  { label: 'Werbekosten', color: 'var(--ink-2)', kind: 'line' },
                ]}
              />
            </div>
            <LineChart
              data={data.timeseries}
              xKey="date"
              series={[
                { key: 'revenue', label: 'Umsatz', color: 'var(--accent)', area: true },
                { key: 'spend', label: 'Werbekosten', color: 'var(--ink-2)' },
              ]}
              formatY={(v) => moneyCompact(v, currency)}
              formatValue={(v) => money(v, currency)}
              formatX={dateLabel}
            />
            <TableToggle>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Umsatz</th>
                      <th>Bestellungen</th>
                      <th>Werbekosten</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.timeseries.map((day) => (
                      <tr key={day.date}>
                        <td>{dateLabel(day.date)}</td>
                        <td>{money(day.revenue, currency)}</td>
                        <td>{int(day.orders)}</td>
                        <td>{money(day.spend, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TableToggle>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Kanäle</h2>
              <p>Zeile anklicken für Kampagnen und Anzeigen</p>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <SortHead id="label" label="Kanal" sort={sort} setSort={setSort} />
                    <SortHead id="spend" label="Kosten" sort={sort} setSort={setSort} />
                    <SortHead id="sessions" label="Sessions" sort={sort} setSort={setSort} />
                    <SortHead id="orders" label="Bestellungen" sort={sort} setSort={setSort} />
                    <SortHead id="revenue" label="Umsatz" sort={sort} setSort={setSort} />
                    <SortHead id="roas" label="ROAS" sort={sort} setSort={setSort} />
                    <SortHead id="cpa" label="CPA" sort={sort} setSort={setSort} />
                    <SortHead id="newOrders" label="Neukunden" sort={sort} setSort={setSort} />
                    <th>Umsatzanteil</th>
                  </tr>
                </thead>
                <tbody>
                  {channelRows.map((r) => (
                    <ChannelRow key={r.key} row={r} currency={currency} total={totalRevenue} />
                  ))}
                </tbody>
              </table>
            </div>
            {kpis.unattributedOrders > 0 && !data.extrapolated && (
              <p className="secondary" style={{ marginTop: 12 }}>
                {int(kpis.unattributedOrders)} Bestellungen ({money(kpis.unattributedRevenue, currency)}) haben keine Journey, meist fehlt die Einwilligung. Unter
                Optionen lassen sie sich anteilig auf die Kanäle hochrechnen.
              </p>
            )}
          </section>

          {data.extrapolation && <ExtrapolationPanel info={data.extrapolation} currency={currency} surveyEnabled={site.settings.survey.enabled} />}

          {data.platforms.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Was die Plattformen melden</h2>
                  <p>Jede Plattform zählt jeden Kauf, an dem sie beteiligt war. Bezzify verteilt jeden Kauf genau einmal.</p>
                </div>
                <div className="segmented" role="group" aria-label="Kennzahl">
                  <button type="button" aria-pressed={metric === 'orders'} onClick={() => setMetric('orders')}>
                    Käufe
                  </button>
                  <button type="button" aria-pressed={metric === 'revenue'} onClick={() => setMetric('revenue')}>
                    Umsatz
                  </button>
                </div>
              </div>
              <Legend
                items={[
                  { label: 'Plattform meldet', color: 'var(--ink-2)', kind: 'ring' },
                  { label: 'Bezzify ordnet zu', color: 'var(--ink-2)', kind: 'dot' },
                ]}
              />
              <div style={{ marginTop: 12 }}>
                <Dumbbell
                  rows={data.platforms.map((p) => ({
                    key: p.channel,
                    label: p.label,
                    color: channelColor(p.channel),
                    claimed: metric === 'orders' ? p.platformConversions : p.platformRevenue,
                    measured: metric === 'orders' ? p.orders : p.revenue,
                  }))}
                  format={(v) => (metric === 'orders' ? int(v) : moneyCompact(v, currency))}
                />
              </div>
              <TableToggle>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Plattform</th>
                      <th>Gemeldete Käufe</th>
                      <th>Zugeordnete Käufe</th>
                      <th>Gemeldeter Umsatz</th>
                      <th>Zugeordneter Umsatz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.platforms.map((platform) => (
                      <tr key={platform.channel}>
                        <td>{platform.label}</td>
                        <td>{int(platform.platformConversions)}</td>
                        <td>{orders(platform.orders)}</td>
                        <td>{money(platform.platformRevenue, currency)}</td>
                        <td>{money(platform.revenue, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableToggle>
            </section>
          )}
        </div>
      )}
      {!data && !error && <p className="muted">Daten werden geladen</p>}
    </>
  );
}

const GROUP_LABELS = { new: 'neue Kunden', returning: 'wiederkehrende Kunden', unknown: 'Kunden ohne bekannten Status' } as const;

function deviationNote(deviation: number): string {
  if (deviation < 0.1) return `Beide Gruppen antworten ähnlich, ${pct(deviation)} der Antworten verteilen sich anders. Die Hochrechnung steht auf sicherem Grund.`;
  if (deviation < 0.25) return `${pct(deviation)} der Antworten verteilen sich anders. Bezzify gleicht das in der Verteilung aus.`;
  return `Käufer ohne Einwilligung kommen deutlich anders, ${pct(deviation)} der Antworten verteilen sich anders. Ohne die Umfrage läge die Hochrechnung spürbar daneben.`;
}

function ExtrapolationPanel({ info, currency, surveyEnabled }: { info: ExtrapolationInfo; currency: string; surveyEnabled: boolean }) {
  const { survey } = info;
  const groups = (Object.keys(GROUP_LABELS) as (keyof typeof GROUP_LABELS)[]).filter((group) => info.byCustomer[group] > 0);
  const answers = survey.answers.filter((answer) => answer.tracked + answer.untracked > 0).sort((a, b) => b.tracked + b.untracked - (a.tracked + a.untracked));
  return (
    <section className="panel" aria-labelledby="h-hochrechnung">
      <div className="panel-head">
        <div>
          <h2 id="h-hochrechnung">Hochrechnung</h2>
          <p>
            {int(info.orders)} Bestellungen ohne Journey ({money(info.revenue, currency)}) sind auf die Kanäle verteilt, jeweils nach dem Muster der zugeordneten Käufe
            derselben Kundengruppe: {groups.map((group) => `${int(info.byCustomer[group])} ${GROUP_LABELS[group]}`).join(', ')}.
          </p>
        </div>
      </div>
      <div className="stack">
        {info.pooled.length > 0 && (
          <p className="secondary">Für {info.pooled.map((group) => GROUP_LABELS[group]).join(' und ')} gab es keinen zugeordneten Kauf, dort gilt das Muster aller Käufe.</p>
        )}
        {survey.applied && survey.deviation !== null ? (
          <>
            <p>
              Die Umfrage nach dem Kauf korrigiert die Verteilung: {int(survey.untracked)} Antworten von Käufern ohne Einwilligung, {int(survey.tracked)} mit
              Einwilligung, aus mindestens 90 Tagen. {deviationNote(survey.deviation)}
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Antwort</th>
                    <th>mit Einwilligung</th>
                    <th>ohne Einwilligung</th>
                  </tr>
                </thead>
                <tbody>
                  {answers.map((answer) => (
                    <tr key={answer.id}>
                      <td>{answer.label}</td>
                      <td>
                        <ShareCell share={answer.tracked / survey.tracked} />
                      </td>
                      <td>
                        <ShareCell share={answer.untracked / survey.untracked} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="secondary">
            {surveyEnabled
              ? 'Noch fehlen Antworten aus beiden Gruppen. Bis dahin gilt die Annahme, dass Käufer ohne Einwilligung innerhalb ihrer Kundengruppe über dieselben Kanäle kommen.'
              : 'Hier gilt die Annahme, dass Käufer ohne Einwilligung innerhalb ihrer Kundengruppe über dieselben Kanäle kommen. Die Umfrage nach dem Kauf prüft das und korrigiert die Verteilung, einzuschalten unter Einrichtung.'}
          </p>
        )}
      </div>
    </section>
  );
}

function ShareCell({ share }: { share: number }) {
  return (
    <>
      <span className="share-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(100, share * 100))}%`, background: 'var(--ink-2)' }} />
      </span>{' '}
      <span className="num secondary">{pct(share)}</span>
    </>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

function ChannelRow({ row, currency, total }: { row: Row; currency: string; total: number }) {
  const share = total > 0 ? row.revenue / total : 0;
  const target = row.key === 'unattributed' ? null : `/kampagnen?channel=${encodeURIComponent(row.key)}`;
  // Klicks auf den Link selbst übernimmt der Browser, sonst öffnete Strg+Klick zusätzlich die Seite im aktuellen Tab
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if (target && !(e.target as Element).closest('a')) navigate(target);
  };
  const channelKey = <ChannelKey channel={row.key} label={row.label} />;
  return (
    <tr className={target ? 'clickable' : undefined} onClick={target ? onRowClick : undefined}>
      <td>
        {target ? (
          <a className="row-link" href={`#${target}`}>
            {channelKey}
          </a>
        ) : (
          channelKey
        )}
      </td>
      <td>{row.spend > 0 ? money(row.spend, currency) : <span className="muted">{NA}</span>}</td>
      <td>{target ? int(row.sessions) : <span className="muted">{NA}</span>}</td>
      <td>{orders(row.orders)}</td>
      <td>{money(row.revenue, currency)}</td>
      <td>{row.roas === null ? <span className="muted">{NA}</span> : ratio(row.roas)}</td>
      <td>{row.cpa === null ? <span className="muted">{NA}</span> : money(row.cpa, currency, 2)}</td>
      <td>{orders(row.newOrders)}</td>
      <td>
        <span className="share-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, share * 100))}%`, background: channelColor(row.key) }} />
        </span>{' '}
        <span className="num secondary">{pct(share)}</span>
      </td>
    </tr>
  );
}
