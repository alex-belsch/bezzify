import { useState } from 'react';
import { ChannelKey } from '../components/Copy';
import { BarList } from '../components/charts';
import { ErrorNote, FilterBar, PageHead } from '../components/Layout';
import { channelColor, money, orders, pct } from '../format';
import { useApi, useApp } from '../state';

interface ModelsRes {
  models: { id: string; label: string }[];
  rows: { channel: string; label: string; values: Record<string, { orders: number; revenue: number }> }[];
  markov: { channel: string; label: string; removalEffect: number }[];
}

export function ModelsPage() {
  const { query, site, filters } = useApp();
  const { data, error, loading } = useApi<ModelsRes>(`/report/models?${query}`);
  const [metric, setMetric] = useState<'orders' | 'revenue'>('revenue');
  const formatMetric = (v: number) => (metric === 'orders' ? orders(v) : money(v, site.currency));

  return (
    <>
      <PageHead
        title="Modelle"
        intro="Dieselben Käufe, verteilt nach sieben Modellen. Große Spannen zeigen Kanäle, deren Bewertung stark von der Sichtweise abhängt."
      />
      <FilterBar />
      <ErrorNote error={error} />
      {data && (
        <div className="stack loading-frame" data-loading={loading}>
          <section className="panel">
            <div className="panel-head">
              <h2>Kanäle je Modell</h2>
              <div className="segmented" role="group" aria-label="Kennzahl">
                <button type="button" aria-pressed={metric === 'revenue'} onClick={() => setMetric('revenue')}>
                  Umsatz
                </button>
                <button type="button" aria-pressed={metric === 'orders'} onClick={() => setMetric('orders')}>
                  Bestellungen
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Kanal</th>
                    {data.models.map((m) => (
                      <th key={m.id} style={m.id === filters.model ? { color: 'var(--accent)' } : undefined}>
                        {m.label}
                      </th>
                    ))}
                    <th>Spanne</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const perModel = data.models.map((m) => row.values[m.id]?.[metric] ?? 0);
                    const min = Math.min(...perModel);
                    const max = Math.max(...perModel);
                    return (
                      <tr key={row.channel}>
                        <td>
                          <ChannelKey channel={row.channel} label={row.label} />
                        </td>
                        {data.models.map((m, i) => (
                          <td key={m.id} style={m.id === filters.model ? { fontWeight: 600, background: 'var(--accent-wash)' } : undefined}>
                            {formatMetric(perModel[i])}
                          </td>
                        ))}
                        <td className="secondary">{max > 0 ? pct((max - min) / max) : pct(0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Removal Effect im datengetriebenen Modell</h2>
                <p>
                  Wie stark sinkt die Kaufwahrscheinlichkeit, wenn ein Kanal aus allen Journeys entfernt wird. Grundlage sind Journeys mit und ohne Kauf im Zeitraum.
                </p>
              </div>
            </div>
            {data.markov.length ? (
              <BarList
                rows={[...data.markov]
                  .sort((a, b) => b.removalEffect - a.removalEffect)
                  .map((effect) => ({ key: effect.channel, label: effect.label, value: effect.removalEffect, color: channelColor(effect.channel) }))}
                format={(v) => pct(v, 1)}
              />
            ) : (
              <p className="muted">Noch zu wenige Journeys für das Modell.</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
