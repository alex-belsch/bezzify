import { one, type Queryable } from './db/index.js';
import { randomId, sha256Hex } from './lib/crypto.js';

export type ModelId =
  | 'first_click'
  | 'last_click'
  | 'last_non_direct'
  | 'linear'
  | 'position_based'
  | 'time_decay'
  | 'data_driven';

export interface SurveyAnswer {
  id: string;
  label: string;
  /** leere Liste steht für alle Kanäle, die keine andere Antwort nennt */
  channels: string[];
}

export interface SurveySettings {
  enabled: boolean;
  question: string;
  answers: SurveyAnswer[];
}

export const defaultSurvey: SurveySettings = {
  enabled: false,
  question: 'Wie bist du auf uns aufmerksam geworden?',
  answers: [
    { id: 'google', label: 'Google Suche', channels: ['google_ads', 'organic_search'] },
    { id: 'instagram_facebook', label: 'Instagram oder Facebook', channels: ['meta', 'organic_social'] },
    { id: 'tiktok', label: 'TikTok', channels: ['tiktok', 'organic_social'] },
    { id: 'youtube', label: 'YouTube', channels: ['google_ads', 'organic_social'] },
    { id: 'pinterest', label: 'Pinterest', channels: ['pinterest', 'organic_social'] },
    { id: 'newsletter', label: 'Newsletter', channels: ['email', 'klaviyo'] },
    { id: 'deals', label: 'Gutschein oder Vergleichsseite', channels: ['awin', 'affiliate', 'referral'] },
    { id: 'ai', label: 'ChatGPT oder eine andere KI', channels: ['ai_assistant'] },
    { id: 'friends', label: 'Empfehlung von Freunden', channels: ['direct'] },
    { id: 'other', label: 'Anders', channels: [] },
  ],
};

export interface SiteSettings {
  attributionModel: ModelId;
  /** null = unbegrenzt */
  windowDays: number | null;
  ignoreDirect: boolean;
  revenueBasis: 'gross' | 'net';
  subtractRefunds: boolean;
  /** Rückspielung an Werbeplattformen nur mit Einwilligung (Standard) */
  consentRequiredForFeedback: boolean;
  /** fbclid oder epik ohne weitere Parameter als bezahlten Klick werten */
  clickIdWithoutParams: 'paid' | 'organic';
  /** z.B. ".myshop.de", damit der Server das Besuchercookie setzt (Safari ITP) */
  cookieDomain: string | null;
  /** Shopify Custom Pixel sendet mit Origin "null" aus der Sandbox */
  allowNullOrigin: boolean;
  feedbackDelayMinutes: number;
  awinDedup: 'last_paid_click' | 'always_aw';
  defaultCountryCode: string;
  timeDecayHalfLifeDays: number;
  /** freiwillige Frage auf der Danke Seite, korrigiert die Hochrechnung der Käufe ohne Einwilligung */
  survey: SurveySettings;
}

export const defaultSettings: SiteSettings = {
  attributionModel: 'last_non_direct',
  windowDays: 30,
  ignoreDirect: true,
  revenueBasis: 'gross',
  subtractRefunds: true,
  consentRequiredForFeedback: true,
  clickIdWithoutParams: 'paid',
  cookieDomain: null,
  allowNullOrigin: false,
  feedbackDelayMinutes: 5,
  awinDedup: 'last_paid_click',
  defaultCountryCode: '49',
  timeDecayHalfLifeDays: 7,
  survey: defaultSurvey,
};

export type Platform = 'shopify' | 'shopware' | 'woocommerce' | 'custom';

export interface Site {
  id: string;
  workspaceId: string;
  name: string;
  platform: Platform;
  domains: string[];
  currency: string;
  timezone: string;
  publicKey: string;
  secretKeyHash: string;
  settings: SiteSettings;
}

interface SiteRow {
  id: string;
  workspace_id: string;
  name: string;
  platform: Platform;
  domains: string[] | null;
  currency: string;
  timezone: string;
  public_key: string;
  secret_key_hash: string;
  settings: Partial<SiteSettings> | null;
}

function rowToSite(row: SiteRow): Site {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    platform: row.platform,
    domains: row.domains ?? [],
    currency: row.currency,
    timezone: row.timezone,
    publicKey: row.public_key,
    secretKeyHash: row.secret_key_hash,
    settings: { ...defaultSettings, ...row.settings },
  };
}

const byPublicKey = new Map<string, { site: Site; at: number }>();
const CACHE_MS = 30_000;

export function clearSiteCache() {
  byPublicKey.clear();
}

export async function getSiteById(q: Queryable, id: string): Promise<Site | null> {
  const row = await one<SiteRow>(q, 'select * from sites where id = $1', [id]);
  return row ? rowToSite(row) : null;
}

export async function getSiteByPublicKey(q: Queryable, key: string): Promise<Site | null> {
  const hit = byPublicKey.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.site;
  const row = await one<SiteRow>(q, 'select * from sites where public_key = $1', [key]);
  if (!row) return null;
  const site = rowToSite(row);
  byPublicKey.set(key, { site, at: Date.now() });
  return site;
}

export async function getSiteBySecret(q: Queryable, secret: string): Promise<Site | null> {
  const row = await one<SiteRow>(q, 'select * from sites where secret_key_hash = $1', [sha256Hex(secret)]);
  return row ? rowToSite(row) : null;
}

export async function listSitesForWorkspaces(q: Queryable, workspaceIds: string[]): Promise<Site[]> {
  if (!workspaceIds.length) return [];
  const rows = await q.query<SiteRow>('select * from sites where workspace_id = any($1) order by created_at', [workspaceIds]);
  return rows.map(rowToSite);
}

export async function listAllSites(q: Queryable): Promise<Site[]> {
  const rows = await q.query<SiteRow>('select * from sites order by created_at');
  return rows.map(rowToSite);
}

export function normalizeDomains(domains: string[]): string[] {
  return [
    ...new Set(
      domains
        .map((domain) =>
          domain
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, '')
            .replace(/^www\./, ''),
        )
        .filter(Boolean),
    ),
  ];
}

export async function createSite(
  q: Queryable,
  input: { workspaceId: string; name: string; platform: Platform; domains: string[]; currency?: string; timezone?: string },
): Promise<{ site: Site; secretKey: string }> {
  const id = randomId('site_', 9);
  const publicKey = randomId('pk_', 15);
  const secretKey = randomId('sk_', 24);
  const settings: Partial<SiteSettings> = input.platform === 'shopify' ? { allowNullOrigin: true } : {};
  await q.query(
    `insert into sites (id, workspace_id, name, platform, domains, currency, timezone, public_key, secret_key_hash, settings)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.workspaceId,
      input.name,
      input.platform,
      normalizeDomains(input.domains),
      input.currency ?? 'EUR',
      input.timezone ?? 'Europe/Berlin',
      publicKey,
      sha256Hex(secretKey),
      JSON.stringify(settings),
    ],
  );
  const site = (await getSiteById(q, id))!;
  return { site, secretKey };
}

export async function rotateSecret(q: Queryable, siteId: string): Promise<string> {
  const secretKey = randomId('sk_', 24);
  await q.query('update sites set secret_key_hash = $2 where id = $1', [siteId, sha256Hex(secretKey)]);
  clearSiteCache();
  return secretKey;
}
