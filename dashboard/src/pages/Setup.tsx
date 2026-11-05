import { useState, type FormEvent, type ReactNode } from 'react';
import { api, errMsg, type SiteInfo, type SiteSettings, type SurveyAnswerSetting } from '../api';
import { ChannelKey, CodeBlock } from '../components/Copy';
import { ErrorNote, PageHead } from '../components/Layout';
import { dateTime, int, labelFor, money, pct } from '../format';
import { todayIn, useApi, useApp } from '../state';

interface FieldDef {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  type?: 'text' | 'checkbox' | 'select';
  placeholder?: string;
  help?: string;
}

interface PlatformState {
  id: string;
  label: string;
  channel: string;
  costs: boolean;
  feedback: boolean;
  description: string;
  fields: FieldDef[];
  configured: boolean;
  enabled: boolean;
  values: Record<string, string | boolean>;
  lastSyncAt: string | null;
  lastError: string | null;
}

interface SetupRes {
  site: SiteInfo;
  endpoint: string;
  webhookUrl: string;
  ordersApi: string;
  snippets: { html: string; htmlGranted: string; consent: string; shopifyPixel: string | null };
  urlTemplates: { platform: string; label: string; where: string; value: string }[];
  survey: {
    endpoint: string;
    serverApi: string;
    channels: { id: string; label: string }[];
    stats: { answers: number; tracked: number; untracked: number; unmatched: number };
  };
  platforms: PlatformState[];
}

const SECTIONS = [
  ['tracking', 'Tracking einbinden'],
  ['parameter', 'URL Parameter'],
  ['anbindungen', 'Anbindungen'],
  ['kosten', 'Manuelle Kosten'],
  ['attribution', 'Attribution und Datenschutz'],
  ['umfrage', 'Umfrage nach dem Kauf'],
  ['shop', 'Shop'],
  ['diagnose', 'Diagnose'],
] as const;

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel" id={`s-${id}`} aria-labelledby={`h-${id}`}>
      <div className="panel-head">
        <div>
          <h2 id={`h-${id}`} tabIndex={-1}>
            {title}
          </h2>
          {intro && <p>{intro}</p>}
        </div>
      </div>
      <div className="stack">{children}</div>
    </section>
  );
}

// der Hash gehört dem Routing, deshalb scrollt das Inhaltsverzeichnis per Skript und setzt den Fokus wie ein normaler Anker
function jumpTo(id: string) {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(`s-${id}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  document.getElementById(`h-${id}`)?.focus({ preventScroll: true });
}

export function SetupPage() {
  const { site } = useApp();
  const { data: setup, error, reload } = useApi<SetupRes>(`/setup?site=${site.id}`);
  return (
    <>
      <PageHead title="Einrichtung" intro="Tracking einbinden, Werbekonten verbinden und festlegen, wie Bezzify Käufe zuordnet." />
      <ErrorNote error={error} />
      {setup && (
        <div className="setup-grid">
          <nav className="toc" aria-label="Abschnitte">
            {SECTIONS.map(([id, label]) => (
              <a
                key={id}
                href="#/einrichtung"
                onClick={(e) => {
                  e.preventDefault();
                  jumpTo(id);
                }}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="stack">
            <TrackingSection setup={setup} />
            <Section id="parameter" title="URL Parameter" intro="Damit Klicks bis auf Anzeigenebene den Kosten zugeordnet werden, gehören diese Parameter in jede Anzeige.">
              {setup.urlTemplates.map((template) => (
                <div key={template.platform} className="form-row">
                  <label>
                    <ChannelKey channel={template.platform} label={template.label} />
                  </label>
                  <span className="help">{template.where}</span>
                  <CodeBlock code={template.value} />
                </div>
              ))}
            </Section>
            <IntegrationsSection setup={setup} reload={reload} />
            <ManualCosts />
            <AttributionSettings key={setup.site.id} setup={setup} reload={reload} />
            <SurveySettingsSection key={`survey-${setup.site.id}`} setup={setup} reload={reload} />
            <ShopSettings key={setup.site.id} setup={setup} reload={reload} />
            <Diagnostics />
          </div>
        </div>
      )}
    </>
  );
}

function TrackingSection({ setup }: { setup: SetupRes }) {
  const { toast } = useApp();
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rotate = async () => {
    if (!window.confirm('Neuen Secret Key erzeugen? Der alte funktioniert danach nicht mehr, Plugins und Server müssen den neuen bekommen.')) return;
    setError(null);
    try {
      const { secretKey } = await api<{ secretKey: string }>(`/sites/${setup.site.id}/rotate-secret`, { method: 'POST' });
      setSecret(secretKey);
      toast('Neuer Secret Key erzeugt');
    } catch (err) {
      setError(errMsg(err));
    }
  };
  const platform = setup.site.platform;
  return (
    <Section id="tracking" title="Tracking einbinden" intro={`Shopsystem: ${labelFor(PLATFORM_LABELS, platform)}. Ändern unter Shop.`}>
      <div className="form-grid">
        <div className="form-row">
          <label>Endpoint</label>
          <CodeBlock code={setup.endpoint} />
        </div>
        <div className="form-row">
          <label>Site Key (öffentlich)</label>
          <CodeBlock code={setup.site.publicKey} />
        </div>
      </div>
      <div className="form-row">
        <label>Secret Key (für Server, Plugins und die Bestell API)</label>
        {secret ? (
          <>
            <CodeBlock code={secret} />
            <span className="help">Nur jetzt sichtbar. Speichere ihn im Plugin oder in den Umgebungsvariablen deines Servers.</span>
          </>
        ) : (
          <div className="form-actions">
            <span className="help">Wird nur beim Erzeugen angezeigt.</span>
            <button type="button" className="btn quiet small" onClick={rotate}>
              Secret Key neu erzeugen
            </button>
          </div>
        )}
        <ErrorNote error={error} />
      </div>

      {platform === 'shopify' && (
        <>
          <h3>1. Custom Pixel anlegen</h3>
          <ol className="steps">
            <li>Shopify Admin, Einstellungen, Kundenereignisse, Benutzerdefiniertes Pixel hinzufügen, Name Bezzify.</li>
            <li>
              Kundendatenschutz auf Erforderlich stellen, Kategorie Analysen. So läuft das Pixel nur mit Einwilligung, Käufe gehen nur mit Marketing Einwilligung an
              Werbeplattformen.
            </li>
            <li>Code einfügen, speichern und verbinden. Ein Skript im Theme ist nicht nötig.</li>
          </ol>
          {setup.snippets.shopifyPixel && <CodeBlock code={setup.snippets.shopifyPixel} />}
          <h3>2. Webhooks für Bestellungen</h3>
          <ol className="steps">
            <li>Einstellungen, Benachrichtigungen, Webhooks, Webhook erstellen.</li>
            <li>Je einmal für Bestellerstellung, Bestellaktualisierung, Bestellstornierung und Rückerstattungserstellung, Format JSON, mit dieser URL:</li>
          </ol>
          <CodeBlock code={setup.webhookUrl} />
          <p className="secondary">Den Signaturschlüssel, den Shopify unter der Webhook Liste zeigt, trägst du unten bei Anbindungen unter Shopify Webhooks ein.</p>
        </>
      )}

      {platform === 'shopware' && (
        <>
          <ol className="steps">
            <li>Den Ordner integrations/shopware/BezzifyTracking nach custom/plugins kopieren.</li>
            <li>
              Im Shop ausführen: <code>bin/console plugin:refresh</code>, dann <code>bin/console plugin:install --activate BezzifyTracking</code> und{' '}
              <code>bin/console cache:clear</code>.
            </li>
            <li>In der Plugin Konfiguration Endpoint, Site Key und Secret Key eintragen.</li>
            <li>
              Im Cookie Consent von Shopware erscheint die Gruppe Bezzify mit zwei Einträgen: Messung und Rückmeldung an Werbeplattformen. Käufe gehen nur mit dem
              zweiten Eintrag an Meta, Google und Co.
            </li>
            <li>Bestellungen laufen über die Nachrichtenwarteschlange von Shopware und werden bei Ausfällen wiederholt, der Worker muss also laufen.</li>
          </ol>
        </>
      )}

      {platform === 'woocommerce' && (
        <>
          <ol className="steps">
            <li>Den Ordner integrations/woocommerce/bezzify als ZIP packen und unter Plugins, Installieren, Plugin hochladen einspielen.</li>
            <li>Unter Einstellungen, Bezzify Endpoint, Site Key und Secret Key eintragen.</li>
            <li>Im Cookie Banner (Borlabs, Real Cookie Banner, Complianz) als Opt In Code hinterlegen:</li>
          </ol>
          <CodeBlock code={setup.snippets.consent} />
        </>
      )}

      {platform === 'custom' && (
        <>
          <h3>1. Skript im Head jeder Seite</h3>
          <CodeBlock code={setup.snippets.html} />
          <p className="secondary">Lädt dein Cookie Banner Skripte erst nach Einwilligung, nimm diese Variante:</p>
          <CodeBlock code={setup.snippets.htmlGranted} />
          <h3>2. Einwilligung melden</h3>
          <CodeBlock code={setup.snippets.consent} />
          <h3>3. Bestellungen vom Server melden</h3>
          <p className="secondary">
            Nach erfolgreicher Zahlung die Bestellung mit dem Secret Key senden. Die Besucher ID steht im Cookie _bzf_id, bei Zahlungs Webhooks am besten schon beim Checkout als
            Metadaten mitgeben (Beispiel in integrations/custom/bezzify-server.ts).
          </p>
          <CodeBlock
            code={`curl -X POST ${setup.ordersApi} \\
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \\
  -d '{"order_id":"1001","total":59.9,"tax":9.56,"currency":"EUR","email":"kunde@example.de","visitor_id":"<_bzf_id>","consent_marketing":true}'`}
          />
        </>
      )}
    </Section>
  );
}

const PLATFORM_LABELS: Record<SiteInfo['platform'], string> = { shopify: 'Shopify', shopware: 'Shopware 6', woocommerce: 'WooCommerce', custom: 'Eigene Website' };

function StatusBadge({ integration }: { integration: PlatformState }) {
  const { site } = useApp();
  if (integration.lastError)
    return (
      <span className="badge err">
        <span className="status-icon" aria-hidden="true">
          !
        </span>
        Fehler
      </span>
    );
  if (integration.configured && integration.enabled)
    return (
      <span className="badge ok">
        <span className="status-icon" aria-hidden="true">
          ✓
        </span>
        {integration.lastSyncAt ? `Verbunden, zuletzt ${dateTime(integration.lastSyncAt, site.timezone)}` : 'Gespeichert'}
      </span>
    );
  return <span className="badge">Nicht eingerichtet</span>;
}

function IntegrationsSection({ setup, reload }: { setup: SetupRes; reload: () => void }) {
  const integrations = setup.platforms.filter((p) => p.id !== 'shopify' || setup.site.platform === 'shopify');
  return (
    <Section
      id="anbindungen"
      title="Anbindungen"
      intro="Zugangsdaten werden verschlüsselt gespeichert und hier nur gekürzt angezeigt. Leere Felder für Schlüssel behalten den gespeicherten Wert."
    >
      {integrations.map((integration) => (
        <IntegrationForm key={integration.id} integration={integration} siteId={setup.site.id} reload={reload} />
      ))}
    </Section>
  );
}

function IntegrationForm({ integration, siteId, reload }: { integration: PlatformState; siteId: string; reload: () => void }) {
  const { toast } = useApp();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const field of integration.fields) {
      initial[field.key] = field.type === 'checkbox' ? !!integration.values[field.key] : field.secret ? '' : String(integration.values[field.key] ?? '');
    }
    return initial;
  });
  const [enabled, setEnabled] = useState(integration.configured ? integration.enabled : true);
  const [busy, setBusy] = useState<'save' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setValue = (key: string, value: string | boolean) => setValues((current) => ({ ...current, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    try {
      await api(`/integrations/${integration.id}?site=${siteId}`, { method: 'PUT', body: { enabled, values } });
      toast(`${integration.label} gespeichert`);
      reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      const costImport = await api<{ rows?: number; error?: string }>(`/integrations/${integration.id}/sync?site=${siteId}&days=30`, { method: 'POST' });
      if (costImport.error) setError(costImport.error);
      else toast(`${int(costImport.rows ?? 0)} Kostenzeilen geladen`);
      reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="integration" onSubmit={save}>
      <div className="integration-head">
        <h3>
          <ChannelKey channel={integration.channel} label={integration.label} />
        </h3>
        <StatusBadge integration={integration} />
      </div>
      <p className="secondary">{integration.description}</p>
      {integration.lastError && <div className="notice error">{integration.lastError}</div>}
      <div className="form-grid">
        {integration.fields
          .filter((field) => field.type !== 'checkbox')
          .map((field) => (
            <div className="form-row" key={field.key}>
              <label htmlFor={`${integration.id}-${field.key}`}>
                {field.label}
                {field.required ? '' : ' (optional)'}
              </label>
              <input
                id={`${integration.id}-${field.key}`}
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={field.secret && integration.values[field.key] ? String(integration.values[field.key]) : field.placeholder}
                value={String(values[field.key] ?? '')}
                onChange={(e) => setValue(field.key, e.target.value)}
              />
              {field.help && <span className="help">{field.help}</span>}
            </div>
          ))}
      </div>
      {integration.fields
        .filter((field) => field.type === 'checkbox')
        .map((field) => (
          <div key={field.key} className="form-row">
            <label className="check">
              <input type="checkbox" checked={!!values[field.key]} onChange={(e) => setValue(field.key, e.target.checked)} />
              {field.label}
            </label>
            {field.help && <span className="help">{field.help}</span>}
          </div>
        ))}
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Anbindung aktiv
      </label>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button type="submit" className="btn" disabled={!!busy}>
          {busy === 'save' ? 'Speichert' : 'Speichern'}
        </button>
        {integration.costs && integration.configured && (
          <button type="button" className="btn quiet" disabled={!!busy} onClick={sync}>
            {busy === 'sync' ? 'Lädt Kosten' : 'Kosten der letzten 30 Tage laden'}
          </button>
        )}
      </div>
    </form>
  );
}

const MANUAL_CHANNELS = ['klaviyo', 'email', 'organic_social', 'affiliate', 'referral', 'organic_search', 'other_paid', 'meta', 'google_ads', 'tiktok', 'pinterest', 'awin'];

function ManualCosts() {
  const { site, me, toast } = useApp();
  const list = useApi<{ rows: { id: string; channel: string; label: string; amount: number; from: string; to: string }[] }>(`/costs/manual?site=${site.id}`);
  const [form, setForm] = useState(() => {
    const today = todayIn(site.timezone);
    return { channel: 'klaviyo', label: '', amount: '', from: today.slice(0, 8) + '01', to: today };
  });
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const amount = Number(form.amount.replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Betrag bitte als Zahl ab 0 angeben, etwa 350 oder 99,90');
      return;
    }
    try {
      await api(`/costs/manual?site=${site.id}`, { method: 'POST', body: { ...form, amount } });
      update({ label: '', amount: '' });
      toast('Kosten gespeichert');
      list.reload();
    } catch (err) {
      setError(errMsg(err));
    }
  };
  const remove = async (id: string) => {
    setError(null);
    try {
      await api(`/costs/manual/${id}?site=${site.id}`, { method: 'DELETE' });
      list.reload();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <Section id="kosten" title="Manuelle Kosten" intro="Für Kosten ohne Schnittstelle, etwa das Klaviyo Abo, Influencer oder Agenturen. Der Betrag wird gleichmäßig auf die Tage verteilt.">
      {list.data && list.data.rows.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Bezeichnung</th>
              <th style={{ textAlign: 'left' }}>Kanal</th>
              <th>Betrag</th>
              <th>Zeitraum</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.rows.map((cost) => (
              <tr key={cost.id}>
                <td>{cost.label}</td>
                <td style={{ textAlign: 'left' }}>
                  <ChannelKey channel={cost.channel} label={labelFor(me.channels, cost.channel)} />
                </td>
                <td>{money(cost.amount, site.currency, 2)}</td>
                <td>
                  {cost.from} bis {cost.to}
                </td>
                <td>
                  <button type="button" className="btn quiet small" onClick={() => remove(cost.id)}>
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={add} className="stack">
        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="mc-label">Bezeichnung</label>
            <input id="mc-label" type="text" required value={form.label} onChange={(e) => update({ label: e.target.value })} placeholder="Klaviyo Abo" />
          </div>
          <div className="form-row">
            <label htmlFor="mc-channel">Kanal</label>
            <select id="mc-channel" value={form.channel} onChange={(e) => update({ channel: e.target.value })}>
              {MANUAL_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {labelFor(me.channels, c)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="mc-amount">Betrag in {site.currency}</label>
            <input id="mc-amount" type="text" inputMode="decimal" required value={form.amount} onChange={(e) => update({ amount: e.target.value })} placeholder="350" />
          </div>
          <div className="form-row">
            <label htmlFor="mc-from">Von</label>
            <input id="mc-from" type="date" required value={form.from} onChange={(e) => update({ from: e.target.value })} />
          </div>
          <div className="form-row">
            <label htmlFor="mc-to">Bis</label>
            <input id="mc-to" type="date" required value={form.to} onChange={(e) => update({ to: e.target.value })} />
          </div>
        </div>
        <ErrorNote error={error} />
        <div className="form-actions">
          <button className="btn" type="submit">
            Kosten hinzufügen
          </button>
        </div>
      </form>
    </Section>
  );
}

type SettingsForm = Omit<SiteSettings, 'feedbackDelayMinutes'> & { feedbackDelayMinutes: number | string };

function AttributionSettings({ setup, reload }: { setup: SetupRes; reload: () => void }) {
  const { me, reloadMe, toast } = useApp();
  const [form, setForm] = useState<SettingsForm>(setup.site.settings);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<SettingsForm>) => setForm((current) => ({ ...current, ...patch }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const settings = {
      attributionModel: form.attributionModel,
      windowDays: form.windowDays,
      ignoreDirect: form.ignoreDirect,
      revenueBasis: form.revenueBasis,
      subtractRefunds: form.subtractRefunds,
      consentRequiredForFeedback: form.consentRequiredForFeedback,
      clickIdWithoutParams: form.clickIdWithoutParams,
      cookieDomain: form.cookieDomain || null,
      feedbackDelayMinutes: Number(form.feedbackDelayMinutes),
      awinDedup: form.awinDedup,
      defaultCountryCode: form.defaultCountryCode,
    };
    try {
      await api(`/sites/${setup.site.id}`, { method: 'PUT', body: { settings } });
      await reloadMe();
      reload();
      toast('Einstellungen gespeichert');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <Section id="attribution" title="Attribution und Datenschutz">
      <form className="stack" onSubmit={save}>
        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="st-model">Standardmodell</label>
            <select id="st-model" value={form.attributionModel} onChange={(e) => update({ attributionModel: e.target.value })}>
              {me.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="st-window">Attributionsfenster</label>
            <select
              id="st-window"
              value={form.windowDays === null ? '' : String(form.windowDays)}
              onChange={(e) => update({ windowDays: e.target.value === '' ? null : Number(e.target.value) })}
            >
              {[1, 7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? 'Tag' : 'Tage'}
                </option>
              ))}
              <option value="">Unbegrenzt</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="st-rev">Umsatzbasis</label>
            <select id="st-rev" value={form.revenueBasis} onChange={(e) => update({ revenueBasis: e.target.value as SiteSettings['revenueBasis'] })}>
              <option value="gross">Brutto, mit Steuer und Versand</option>
              <option value="net">Netto, ohne Steuer und Versand</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="st-fbclid">Klick IDs ohne URL Parameter</label>
            <select
              id="st-fbclid"
              value={form.clickIdWithoutParams}
              onChange={(e) => update({ clickIdWithoutParams: e.target.value as SiteSettings['clickIdWithoutParams'] })}
            >
              <option value="paid">fbclid und epik als bezahlten Klick werten</option>
              <option value="organic">als organischen Besuch werten</option>
            </select>
            <span className="help">Meta und Pinterest hängen ihre Klick ID auch an organische Links.</span>
          </div>
          <div className="form-row">
            <label htmlFor="st-cookie">Cookie Domain (optional)</label>
            <input id="st-cookie" type="text" value={form.cookieDomain ?? ''} placeholder=".deinshop.de" onChange={(e) => update({ cookieDomain: e.target.value })} />
            <span className="help">Läuft Bezzify auf einer Subdomain deines Shops, setzt der Server das Besuchercookie selbst. Das hält in Safari länger.</span>
          </div>
          <div className="form-row">
            <label htmlFor="st-delay">Rückspielung verzögern um Minuten</label>
            <input id="st-delay" type="number" min={0} max={1440} value={form.feedbackDelayMinutes} onChange={(e) => update({ feedbackDelayMinutes: e.target.value })} />
          </div>
          <div className="form-row">
            <label htmlFor="st-awin">Awin Deduplizierung</label>
            <select id="st-awin" value={form.awinDedup} onChange={(e) => update({ awinDedup: e.target.value as SiteSettings['awinDedup'] })}>
              <option value="last_paid_click">Nur wenn Awin der letzte bezahlte Klick war</option>
              <option value="always_aw">Jeden Kauf mit Awin Klick als Awin melden</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="st-cc">Ländervorwahl für Telefonnummern</label>
            <input
              id="st-cc"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{1,3}"
              value={form.defaultCountryCode}
              onChange={(e) => update({ defaultCountryCode: e.target.value })}
            />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.ignoreDirect} onChange={(e) => update({ ignoreDirect: e.target.checked })} />
          Direktzugriffe ignorieren, wenn es andere Touchpoints gibt
        </label>
        <label className="check">
          <input type="checkbox" checked={form.subtractRefunds} onChange={(e) => update({ subtractRefunds: e.target.checked })} />
          Erstattungen vom Umsatz abziehen
        </label>
        <label className="check">
          <input type="checkbox" checked={form.consentRequiredForFeedback} onChange={(e) => update({ consentRequiredForFeedback: e.target.checked })} />
          Käufe nur mit Einwilligung an Werbeplattformen zurückspielen
        </label>
        {!form.consentRequiredForFeedback && (
          <div className="notice">Ohne Einwilligung gehen gehashte Kundendaten an Meta, Google und Co. Das sollte vorher datenschutzrechtlich geprüft sein.</div>
        )}
        <ErrorNote error={error} />
        <div className="form-actions">
          <button className="btn" type="submit">
            Einstellungen speichern
          </button>
        </div>
      </form>
    </Section>
  );
}

type AnswerDraft = SurveyAnswerSetting & { key: number };

// Kennungen bleiben beim Umbenennen gleich, damit alte Antworten weiter zählen; neue entstehen aus der Beschriftung
export function answerId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28) || 'antwort';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

function SurveySettingsSection({ setup, reload }: { setup: SetupRes; reload: () => void }) {
  const { reloadMe, toast } = useApp();
  const saved = setup.site.settings.survey;
  const [enabled, setEnabled] = useState(saved.enabled);
  const [question, setQuestion] = useState(saved.question);
  const [answers, setAnswers] = useState<AnswerDraft[]>(() => saved.answers.map((answer, index) => ({ ...answer, key: index })));
  const [nextKey, setNextKey] = useState(saved.answers.length);
  const [error, setError] = useState<string | null>(null);
  const channelLabel = new Map(setup.survey.channels.map((channel) => [channel.id, channel.label]));
  const { stats } = setup.survey;

  const patch = (key: number, change: Partial<SurveyAnswerSetting>) =>
    setAnswers((current) => current.map((answer) => (answer.key === key ? { ...answer, ...change } : answer)));
  const toggleChannel = (answer: AnswerDraft, channel: string, on: boolean) =>
    patch(answer.key, { channels: on ? [...answer.channels, channel] : answer.channels.filter((c) => c !== channel) });
  const add = () => {
    setAnswers((current) => [...current, { key: nextKey, id: '', label: '', channels: [] }]);
    setNextKey((key) => key + 1);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const taken = new Set(answers.map((answer) => answer.id).filter(Boolean));
    const survey = {
      enabled,
      question,
      answers: answers.map(({ id, label, channels }) => {
        if (id) return { id, label, channels };
        const fresh = answerId(label, taken);
        taken.add(fresh);
        return { id: fresh, label, channels };
      }),
    };
    try {
      await api(`/sites/${setup.site.id}`, { method: 'PUT', body: { settings: { survey } } });
      await reloadMe();
      reload();
      toast('Umfrage gespeichert');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const platform = setup.site.platform;
  return (
    <Section
      id="umfrage"
      title="Umfrage nach dem Kauf"
      intro="Eine freiwillige Frage auf der Danke Seite. Die Antworten zeigen, ob Käufer ohne Einwilligung über andere Kanäle kommen als die übrigen, und korrigieren damit die Hochrechnung."
    >
      <form className="stack" onSubmit={save}>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Frage auf der Danke Seite zeigen
        </label>
        <div className="form-row">
          <label htmlFor="sv-question">Frage</label>
          <input id="sv-question" type="text" required minLength={3} maxLength={140} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </div>
        <fieldset className="survey-answers">
          <legend>Antworten</legend>
          <p className="help">Jede Antwort zählt für die Kanäle, die sie nennt. Eine Antwort ohne Kanäle steht für alle Kanäle, die keine andere Antwort nennt.</p>
          {answers.map((answer, index) => (
            <div className="survey-answer" key={answer.key}>
              <input
                type="text"
                required
                maxLength={60}
                aria-label={`Antwort ${index + 1}`}
                value={answer.label}
                onChange={(e) => patch(answer.key, { label: e.target.value })}
              />
              <details className="options">
                <summary aria-label={`Kanäle für Antwort ${index + 1}`}>
                  {answer.channels.length ? answer.channels.map((channel) => channelLabel.get(channel) ?? channel).join(', ') : 'übrige Kanäle'}
                </summary>
                <div className="popover channel-picker">
                  {setup.survey.channels.map((channel) => (
                    <label key={channel.id} className="check">
                      <input
                        type="checkbox"
                        checked={answer.channels.includes(channel.id)}
                        onChange={(e) => toggleChannel(answer, channel.id, e.target.checked)}
                      />
                      {channel.label}
                    </label>
                  ))}
                </div>
              </details>
              <button
                type="button"
                className="btn quiet small"
                disabled={answers.length <= 2}
                onClick={() => setAnswers((current) => current.filter((other) => other.key !== answer.key))}
              >
                Entfernen
              </button>
            </div>
          ))}
          <div className="form-actions">
            <button type="button" className="btn quiet small" disabled={answers.length >= 12} onClick={add}>
              Antwort hinzufügen
            </button>
          </div>
        </fieldset>
        <div className="notice">
          Die Frage gehört nur auf die Danke Seite. Per Mail wäre sie nach der Rechtsprechung des BGH Werbung und bräuchte eine Einwilligung. In die
          Datenschutzerklärung gehört ein Satz zur freiwilligen Angabe: Zweck ist die Auswertung der Werbekanäle, Rechtsgrundlage das berechtigte Interesse.
        </div>
        <p className="secondary">
          In den letzten 30 Tagen {int(stats.answers)} Antworten, {int(stats.tracked)} von Käufern mit Einwilligung, {int(stats.untracked)} ohne
          {stats.unmatched > 0 ? `, ${int(stats.unmatched)} noch ohne passende Bestellung` : ''}.
        </p>
        <ErrorNote error={error} />
        <div className="form-actions">
          <button className="btn" type="submit">
            Umfrage speichern
          </button>
        </div>
      </form>

      {platform === 'shopify' && (
        <>
          <h3>Danke Seite in Shopify</h3>
          <ol className="steps">
            <li>
              Mit der Shopify CLI eine eigene App für den Shop anlegen (<code>shopify app init</code>), darin eine Checkout Erweiterung erzeugen (
              <code>shopify app generate extension --template checkout_ui</code>) und deren Dateien durch die aus integrations/shopify/survey-extension ersetzen.
              Die erzeugte uid in der shopify.extension.toml bleibt stehen.
            </li>
            <li>Im Partner Dashboard unter API Zugriffsanfragen der App den Netzwerkzugriff für Checkout UI Erweiterungen erlauben.</li>
            <li>
              Mit <code>shopify app deploy</code> veröffentlichen und die App im Shop installieren.
            </li>
            <li>Im Checkout Editor (Einstellungen, Checkout, Anpassen) die Danke Seite öffnen, den Block Bezzify Umfrage hinzufügen und diese Werte eintragen:</li>
          </ol>
          <div className="form-grid">
            <div className="form-row">
              <label>Endpoint</label>
              <CodeBlock code={setup.endpoint} />
            </div>
            <div className="form-row">
              <label>Site Key</label>
              <CodeBlock code={setup.site.publicKey} />
            </div>
          </div>
        </>
      )}
      {(platform === 'woocommerce' || platform === 'shopware') && (
        <p className="secondary">
          Das Plugin zeigt die Frage auf der Danke Seite, sobald sie hier eingeschaltet ist, und leitet die Antwort über den Server mit dem Secret Key weiter.
        </p>
      )}
      {platform === 'custom' && (
        <>
          <p className="secondary">
            Die Frage abrufen und auf der Danke Seite zeigen, die Antwort dann vom eigenen Server mit dem Secret Key melden. Ein Helfer dafür steht in
            integrations/custom/bezzify-server.ts.
          </p>
          <CodeBlock
            code={`curl "${setup.survey.endpoint}?k=${setup.site.publicKey}"

curl -X POST ${setup.survey.serverApi} \\
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \\
  -d '{"answer":"google"}'`}
          />
        </>
      )}
    </Section>
  );
}

function ShopSettings({ setup, reload }: { setup: SetupRes; reload: () => void }) {
  const { reloadMe, toast } = useApp();
  const [form, setForm] = useState({
    name: setup.site.name,
    platform: setup.site.platform,
    domains: setup.site.domains.join(', '),
    currency: setup.site.currency,
    timezone: setup.site.timezone,
  });
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/sites/${setup.site.id}`, {
        method: 'PUT',
        body: { ...form, domains: form.domains.split(/[\s,]+/).filter(Boolean) },
      });
      await reloadMe();
      reload();
      toast('Shop gespeichert');
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <Section id="shop" title="Shop">
      <form className="stack" onSubmit={save}>
        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="shop-name">Name</label>
            <input id="shop-name" type="text" required value={form.name} onChange={(e) => update({ name: e.target.value })} />
          </div>
          <div className="form-row">
            <label htmlFor="shop-platform">Shopsystem</label>
            <select id="shop-platform" value={form.platform} onChange={(e) => update({ platform: e.target.value as SiteInfo['platform'] })}>
              {Object.entries(PLATFORM_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="shop-domains">Domains</label>
            <input id="shop-domains" type="text" value={form.domains} onChange={(e) => update({ domains: e.target.value })} />
            <span className="help">Kommagetrennt, bei Shopify auch die myshopify Domain. Nur von hier werden Events angenommen.</span>
          </div>
          <div className="form-row">
            <label htmlFor="shop-cur">Währung</label>
            <input
              id="shop-cur"
              type="text"
              required
              maxLength={3}
              pattern="[A-Za-z]{3}"
              value={form.currency}
              onChange={(e) => update({ currency: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="form-row">
            <label htmlFor="shop-tz">Zeitzone</label>
            <input id="shop-tz" type="text" value={form.timezone} onChange={(e) => update({ timezone: e.target.value })} />
          </div>
        </div>
        <ErrorNote error={error} />
        <div className="form-actions">
          <button className="btn" type="submit">
            Shop speichern
          </button>
        </div>
      </form>
    </Section>
  );
}

interface DiagRes {
  events24h: number;
  lastEvent: string | null;
  sessions24h: { identified: number; anonymous: number };
  orders7d: { total: number; with_visitor: number; pixel_only: number; with_consent: number };
  paidParams: { channel: string; label: string; total: number; missing: number }[];
  outbox: { target: string; status: string; n: number; last_error: string | null }[];
}

const STATUS_LABELS: Record<string, string> = { pending: 'wartet', sent: 'gesendet', skipped: 'übersprungen', failed: 'fehlgeschlagen' };

function Diagnostics() {
  const { site, me } = useApp();
  const { data, error } = useApi<DiagRes>(`/diagnostics?site=${site.id}`, { refreshMs: 30000 });
  const intro = 'Prüft, ob Daten vollständig ankommen.';
  if (!data) {
    if (!error) return null;
    return (
      <Section id="diagnose" title="Diagnose" intro={intro}>
        <ErrorNote error={error} />
      </Section>
    );
  }
  const { orders7d } = data;
  return (
    <Section id="diagnose" title="Diagnose" intro={intro}>
      <ErrorNote error={error} />
      <div className="kpis" style={{ border: '1px solid var(--rule)', borderRadius: 8 }}>
        <div className="kpi">
          <span className="label">Events in 24 Stunden</span>
          <span className="value">{int(data.events24h)}</span>
          <span className="sub">{data.lastEvent ? `zuletzt ${dateTime(data.lastEvent, site.timezone)}` : 'noch keine'}</span>
        </div>
        <div className="kpi">
          <span className="label">Sessions in 24 Stunden</span>
          <span className="value">{int(data.sessions24h.identified + data.sessions24h.anonymous)}</span>
          <span className="sub">{int(data.sessions24h.anonymous)} davon ohne Einwilligung</span>
        </div>
        <div className="kpi">
          <span className="label">Bestellungen in 7 Tagen</span>
          <span className="value">{int(orders7d.total)}</span>
          <span className="sub">
            {orders7d.total ? pct(orders7d.with_visitor / orders7d.total) : pct(0)} mit Besucher ID, {int(orders7d.pixel_only)} nur vom Pixel
          </span>
        </div>
      </div>
      {orders7d.pixel_only > 0 && (
        <div className="notice">
          {int(orders7d.pixel_only)} Bestellungen kamen nur vom Pixel und nicht vom Shop selbst. Prüfe Webhooks oder Plugin, sonst fehlen Stornos und Erstattungen.
        </div>
      )}
      {data.sessions24h.anonymous > 0 && (
        <div className="notice">
          Es kommen Einstiege ohne Einwilligung an, das Skript zählt sie mit der Option cookieless. Nach Ansicht der deutschen Datenschutzbehörden braucht auch
          das eine Einwilligung, weil das Skript Adresse und Herkunft der Seite ausliest (§ 25 TDDDG). Die Option nur nach rechtlicher Prüfung eingeschaltet
          lassen. Die Hochrechnung nutzt diese Einstiege nicht.
        </div>
      )}
      {data.paidParams.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Bezahlte Sessions in 7 Tagen</th>
              <th>Sessions</th>
              <th>ohne Kampagnenkennung</th>
            </tr>
          </thead>
          <tbody>
            {data.paidParams.map((row) => (
              <tr key={row.channel}>
                <td>
                  <ChannelKey channel={row.channel} label={row.label} />
                </td>
                <td>{int(row.total)}</td>
                <td style={row.total && row.missing / row.total > 0.2 ? { color: 'var(--critical)', fontWeight: 600 } : undefined}>
                  {row.total ? pct(row.missing / row.total) : pct(0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.outbox.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Rückspielung</th>
              <th>Status</th>
              <th>Anzahl</th>
              <th style={{ textAlign: 'left' }}>Letzter Hinweis</th>
            </tr>
          </thead>
          <tbody>
            {data.outbox.map((entry) => (
              <tr key={`${entry.target}|${entry.status}`}>
                <td>{labelFor(me.channels, entry.target)}</td>
                <td>{labelFor(STATUS_LABELS, entry.status)}</td>
                <td>{int(entry.n)}</td>
                <td style={{ textAlign: 'left', whiteSpace: 'normal' }} className="secondary">
                  {entry.last_error ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
