import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// In der Entwicklung liegt der Schlüssel unter data/, damit Sessions und Zugangsdaten einen Neustart überleben
function resolveAppSecret(): string {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (env.APP_SECRET) throw new Error('APP_SECRET muss mindestens 32 Zeichen lang sein');
  if (isProd) throw new Error('APP_SECRET fehlt (mindestens 32 Zeichen, z.B. openssl rand -hex 32)');
  const secretFile = env.APP_SECRET_FILE || './data/.app-secret';
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  mkdirSync(dirname(secretFile), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

let cachedSecret: string | null = null;

/** Anzahl eigener Proxys vor Bezzify, "1" oder "true" für einen (Coolify, Traefik, Caddy), "2" etwa mit Cloudflare davor */
function parseTrustProxy(value: string | undefined): number {
  if (!value || value === 'false' || value === '0') return 0;
  if (value === 'true') return 1;
  const hops = Number(value);
  return Number.isInteger(hops) && hops > 0 ? Math.min(hops, 10) : 0;
}

export const config = {
  isProd,
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  /** leer bedeutet eingebettete Datenbank (PGlite) unter pgliteDir */
  databaseUrl: env.DATABASE_URL ?? '',
  pgliteDir: env.PGLITE_DIR ?? './data/pglite',
  get appSecret(): string {
    if (!cachedSecret) cachedSecret = resolveAppSecret();
    return cachedSecret;
  },
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/$/, ''),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  jobsEnabled: env.DISABLE_JOBS !== '1',
  logLevel: (env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  /** danach werden Events, Sessions und Identitäten gelöscht */
  retentionDays: Number(env.RETENTION_DAYS ?? 400),
  /** IP, User Agent und Werbecookies je Bestellung, nur für die Rückspielung */
  matchDataRetentionDays: Number(env.MATCH_DATA_RETENTION_DAYS ?? 7),
  sessionTimeoutMinutes: Number(env.SESSION_TIMEOUT_MINUTES ?? 30),
  dashboardDir: env.DASHBOARD_DIR ?? './dist/dashboard',
};

export type Config = typeof config;
