import { useMemo } from 'react';
import type { JourneyOrder } from '../api';
import { ErrorNote, FilterBar, PageHead } from '../components/Layout';
import { JourneyRoute } from '../components/JourneyRoute';
import { channelColor, duration, int, labelFor, pct, ratio } from '../format';
import { navigate, useApi, useApp } from '../state';

const FILTER_CHANNELS = ['meta', 'google_ads', 'tiktok', 'pinterest', 'awin', 'klaviyo', 'organic_search', 'organic_social', 'direct'];

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function JourneysPage({ params }: { params: URLSearchParams }) {
  const { query, site, me } = useApp();
  const channel = params.get('channel');
  const { data, error, loading } = useApi<{ orders: JourneyOrder[]; total: number }>(
    `/journeys?${query}&limit=60${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`,
  );

  const stats = useMemo(() => {
    const list = data?.orders ?? [];
    const withTouches = list.filter((o) => o.touchCount > 0);
    const avgTouches = withTouches.length ? withTouches.reduce((s, o) => s + o.touchCount, 0) / withTouches.length : null;
    const days = withTouches.flatMap((o) => (o.daysToConvert === null ? [] : [o.daysToConvert]));
    const multi = withTouches.length ? withTouches.filter((o) => new Set(o.touches.map((t) => t.channel)).size > 1).length / withTouches.length : null;
    return { avgTouches, median: median(days), multi, count: list.length };
  }, [data]);

  const setChannel = (c: string | null) => navigate(c ? `/journeys?channel=${encodeURIComponent(c)}` : '/journeys');

  return (
    <>
      <PageHead
        title="Journeys"
        intro="Der Weg zu jedem Kauf, Besuch für Besuch. Jede Station ist ein Besuch, darunter steht der Anteil, den das gewählte Modell ihr gibt."
      />
      <FilterBar />
      <ErrorNote error={error} />
      <div className="chips" role="group" aria-label="Nach Kanal filtern">
        <button type="button" className="chip" aria-pressed={!channel} onClick={() => setChannel(null)}>
          Alle Kanäle
        </button>
        {FILTER_CHANNELS.map((c) => (
          <button key={c} type="button" className="chip" aria-pressed={channel === c} onClick={() => setChannel(c)}>
            <span className="dot" style={{ background: channelColor(c) }} />
            {labelFor(me.channels, c)}
          </button>
        ))}
      </div>
      {data && (
        <section className="panel loading-frame" data-loading={loading}>
          <div className="panel-head">
            <h2>
              {int(stats.count)} {channel ? `Käufe mit ${labelFor(me.channels, channel)}` : 'jüngste Käufe'}
            </h2>
            <p>
              {stats.avgTouches !== null ? `${ratio(stats.avgTouches, 1)} Besuche je Kauf im Schnitt` : ''}
              {stats.median !== null ? `, Median bis zum Kauf ${duration(stats.median)}` : ''}
              {stats.multi !== null ? `, ${pct(stats.multi)} mit mehr als einem Kanal` : ''}
            </p>
          </div>
          {data.orders.length === 0 ? (
            <div className="empty">
              <p>Im Zeitraum gibt es keine passenden Käufe.</p>
            </div>
          ) : (
            <div className="journey-list">
              {data.orders.map((order) => (
                <JourneyRoute key={order.id} order={order} currency={site.currency} timeZone={site.timezone} />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
