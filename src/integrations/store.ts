import { one, type Queryable } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { platformDef } from './registry.js';

export interface Integration {
  siteId: string;
  platform: string;
  enabled: boolean;
  /** nicht geheime Werte im Klartext, geheime entschlüsselt zusammengeführt */
  values: Record<string, any>;
  lastSyncAt: Date | null;
  lastError: string | null;
}

function toIntegration(siteId: string, row: any): Integration {
  return {
    siteId,
    platform: row.platform,
    enabled: row.enabled,
    values: { ...(row.config ?? {}), ...(decrypt<Record<string, string>>(row.secrets) ?? {}) },
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  };
}

export async function getIntegration(q: Queryable, siteId: string, platform: string): Promise<Integration | null> {
  const row = await one(q, 'select * from integrations where site_id = $1 and platform = $2', [siteId, platform]);
  return row ? toIntegration(siteId, row) : null;
}

export async function listIntegrations(q: Queryable, siteId: string): Promise<Integration[]> {
  const rows = await q.query('select * from integrations where site_id = $1', [siteId]);
  return rows.map((row) => toIntegration(siteId, row));
}

/** Leere geheime Felder behalten den gespeicherten Wert */
export async function saveIntegration(
  q: Queryable,
  siteId: string,
  platform: string,
  input: { enabled?: boolean; values: Record<string, unknown> },
): Promise<void> {
  const def = platformDef(platform);
  if (!def) throw new Error(`Unbekannte Plattform: ${platform}`);
  const existing = await getIntegration(q, siteId, platform);
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const field of def.fields) {
    const submitted = input.values[field.key];
    if (field.type === 'checkbox') {
      config[field.key] =
        submitted === undefined ? !!existing?.values[field.key] : submitted === true || submitted === 'true' || submitted === 'on';
      continue;
    }
    const text = submitted === undefined || submitted === null ? undefined : String(submitted).trim();
    if (field.secret) {
      if (text) secrets[field.key] = text;
      else if (existing?.values[field.key]) secrets[field.key] = existing.values[field.key];
    } else if (text !== undefined) {
      if (text) config[field.key] = text;
    } else if (existing?.values[field.key] !== undefined) {
      config[field.key] = existing.values[field.key];
    }
  }
  await q.query(
    `insert into integrations (site_id, platform, enabled, config, secrets, updated_at) values ($1,$2,$3,$4,$5, now())
     on conflict (site_id, platform) do update set enabled = excluded.enabled, config = excluded.config,
       secrets = excluded.secrets, updated_at = now(), last_error = null`,
    [siteId, platform, input.enabled ?? existing?.enabled ?? true, JSON.stringify(config), encrypt(secrets)],
  );
}

export async function markSync(q: Queryable, siteId: string, platform: string, error: string | null) {
  await q.query(
    `update integrations set last_sync_at = case when $3::text is null then now() else last_sync_at end, last_error = $3
     where site_id = $1 and platform = $2`,
    [siteId, platform, error],
  );
}

export function missingRequired(platform: string, values: Record<string, any>): string[] {
  const def = platformDef(platform);
  if (!def) return [];
  return def.fields.filter((field) => field.required && !values[field.key]).map((field) => field.label);
}

/** Für das Dashboard, Geheimnisse nur mit den letzten vier Zeichen */
export function maskValues(platform: string, values: Record<string, any>): Record<string, string | boolean> {
  const def = platformDef(platform);
  const masked: Record<string, string | boolean> = {};
  for (const field of def?.fields ?? []) {
    const stored = values[field.key];
    if (field.type === 'checkbox') masked[field.key] = !!stored;
    else if (field.secret) masked[field.key] = stored ? `•••• ${String(stored).slice(-4)}` : '';
    else masked[field.key] = stored ?? '';
  }
  return masked;
}

/** Entfernt gespeicherte Geheimnisse aus einer Fehlermeldung, Meta etwa wiederholt bei "Malformed access token" das Token */
export function redactSecrets(platform: string, values: Record<string, any>, message: string): string {
  let redacted = message;
  for (const field of platformDef(platform)?.fields ?? []) {
    const secret = values[field.key];
    // kurze Werte nicht ersetzen, sie kämen auch zufällig in Meldungen vor
    if (field.secret && typeof secret === 'string' && secret.length >= 8) redacted = redacted.replaceAll(secret, '***');
  }
  return redacted;
}
