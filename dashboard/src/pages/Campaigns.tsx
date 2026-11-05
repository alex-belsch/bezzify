import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Row } from '../api';
import { ErrorNote, FilterBar, PageHead } from '../components/Layout';
import { SortHead, sortRows, type Sort } from '../components/SortHead';
import { NA, channelColor, int, money, orders, ratio } from '../format';
import { navigate, useApi, useApp } from '../state';

interface BreakdownRes {
  rows: Row[];
  totals: Row;
  currency: string;
  extrapolated: boolean;
}

const PREFERRED = ['meta', 'google_ads', 'tiktok', 'pinterest', 'awin', 'klaviyo'];

export function CampaignsPage({ params }: { params: URLSearchParams }) {
  const { query, site } = useApp();
  const currency = site.currency;
  const list = useApi<BreakdownRes>(`/report/breakdown?${query}`);
  const channels = useMemo(() => {
    const rows = list.data?.rows ?? [];
    const withData = rows.filter((r) => r.spend > 0 || r.orders > 0.01 || r.sessions > 0);
    return withData.sort((a, b) => {
      const pa = PREFERRED.indexOf(a.key);
      const pb = PREFERRED.indexOf(b.key);
      return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb) || b.revenue - a.revenue;
    });
  }, [list.data]);
  const requested = params.get('channel');
  const channel = requested ?? channels[0]?.key ?? null;
  const detail = useApi<BreakdownRes>(channel ? `/report/breakdown?${query}&channel=${encodeURIComponent(channel)}` : null);
  const node = detail.data?.rows.find((r) => r.key === channel) ?? null;
  const [sort, setSort] = useState<Sort>({ key: 'spend', dir: -1 });
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => setOpen(new Set()), [channel]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const campaigns = node?.children ? sortRows(node.children, sort) : [];
  const missing = campaigns.find((c) => c.key === '');

  return (
    <>
      <PageHead title="Kampagnen" intro="Kosten der Plattformen neben den Käufen, die Bezzify zuordnet, bis auf Anzeigenebene." />
      <FilterBar />
      <ErrorNote error={list.error ?? detail.error} />
      <div className="chips" role="group" aria-label="Kanal">
        {channels.map((row) => (
          <button key={row.key} type="button" className="chip" aria-pressed={row.key === channel} onClick={() => navigate(`/kampagnen?channel=${encodeURIComponent(row.key)}`)}>
            <span className="dot" style={{ background: channelColor(row.key) }} />
            {row.label}
          </button>
        ))}
      </div>
      {node && (
        <section className="panel loading-frame" data-loading={detail.loading}>
          <div className="panel-head">
            <h2>{node.label}</h2>
            <p>
              {money(node.spend, currency)} Kosten, {orders(node.orders)} Bestellungen, ROAS {ratio(node.roas)}
            </p>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <SortHead id="label" label="Kampagne, Anzeigengruppe, Anzeige" sort={sort} setSort={setSort} />
                  <SortHead id="spend" label="Kosten" sort={sort} setSort={setSort} />
                  <SortHead id="clicks" label="Klicks" sort={sort} setSort={setSort} />
                  <SortHead id="sessions" label="Sessions" sort={sort} setSort={setSort} />
                  <SortHead id="orders" label="Bestellungen" sort={sort} setSort={setSort} />
                  <SortHead id="revenue" label="Umsatz" sort={sort} setSort={setSort} />
                  <SortHead id="roas" label="ROAS" sort={sort} setSort={setSort} />
                  <SortHead id="cpa" label="CPA" sort={sort} setSort={setSort} />
                  <SortHead id="platformConversions" label="Plattform meldet" sort={sort} setSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => {
                  const cid = `c:${campaign.key}`;
                  const adsets = campaign.children ? sortRows(campaign.children, sort) : [];
                  return (
                    <Fragment key={cid}>
                      <TreeRow row={campaign} depth={0} currency={currency} open={open.has(cid)} onToggle={hasDetail(adsets) ? () => toggle(cid) : undefined} />
                      {open.has(cid) &&
                        adsets.map((adset) => {
                          const sid = `${cid}|s:${adset.key}`;
                          const ads = adset.children ? sortRows(adset.children, sort) : [];
                          return (
                            <Fragment key={sid}>
                              <TreeRow row={adset} depth={1} currency={currency} open={open.has(sid)} onToggle={hasDetail(ads) ? () => toggle(sid) : undefined} />
                              {open.has(sid) && ads.map((ad) => <TreeRow key={`${sid}|a:${ad.key}`} row={ad} depth={2} currency={currency} />)}
                            </Fragment>
                          );
                        })}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Summe</td>
                  <td>{money(node.spend, currency)}</td>
                  <td>{int(node.clicks)}</td>
                  <td>{int(node.sessions)}</td>
                  <td>{orders(node.orders)}</td>
                  <td>{money(node.revenue, currency)}</td>
                  <td>{ratio(node.roas)}</td>
                  <td>{node.cpa === null ? NA : money(node.cpa, currency, 2)}</td>
                  <td>{node.platformConversions ? int(node.platformConversions) : NA}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {missing && missing.sessions > 0 && node.spend > 0 && (
            <p className="secondary" style={{ marginTop: 12 }}>
              {int(missing.sessions)} Sessions kamen ohne Kampagnenkennung. Hinterlege die URL Parameter aus der Einrichtung in den Anzeigen, dann landen sie bei der
              richtigen Kampagne.
            </p>
          )}
        </section>
      )}
      {!channels.length && list.data && (
        <div className="empty">
          <p>Für den Zeitraum gibt es noch keine Kanäle mit Daten.</p>
          <a className="btn quiet" href="#/einrichtung">
            Tracking einrichten
          </a>
        </div>
      )}
    </>
  );
}

// eine einzelne Unterzeile ohne Kennung, etwa ohne Anzeigengruppe, bringt beim Aufklappen nichts Neues
function hasDetail(children: Row[]): boolean {
  return children.length > 1 || (children.length === 1 && children[0].key !== '');
}

function TreeRow({ row, depth, currency, open, onToggle }: { row: Row; depth: number; currency: string; open?: boolean; onToggle?: () => void }) {
  return (
    <tr className={`depth-${depth}${onToggle ? ' clickable' : ''}`} onClick={onToggle}>
      <td className="name">
        {onToggle ? (
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={!!open}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <svg className="chevron" data-open={!!open} viewBox="0 0 14 14" aria-hidden="true">
              <path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {row.label}
          </button>
        ) : (
          <span style={{ paddingLeft: depth === 0 ? 22 : 0 }}>{row.label}</span>
        )}
      </td>
      <td>{row.spend > 0 ? money(row.spend, currency) : <span className="muted">{NA}</span>}</td>
      <td>{row.clicks ? int(row.clicks) : <span className="muted">{NA}</span>}</td>
      <td>{int(row.sessions)}</td>
      <td>{orders(row.orders)}</td>
      <td>{money(row.revenue, currency)}</td>
      <td>{row.roas === null ? <span className="muted">{NA}</span> : ratio(row.roas)}</td>
      <td>{row.cpa === null ? <span className="muted">{NA}</span> : money(row.cpa, currency, 2)}</td>
      <td>{row.platformConversions ? int(row.platformConversions) : <span className="muted">{NA}</span>}</td>
    </tr>
  );
}
