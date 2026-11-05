import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { errMsg, log } from '../lib/log.js';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  kind: 'pg' | 'pglite';
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let current: Db | null = null;

export function db(): Db {
  if (!current) throw new Error('Datenbank ist nicht geöffnet');
  return current;
}

export async function one<T = any>(q: Queryable, sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await q.query<T>(sql, params);
  return rows[0] ?? null;
}

export interface OpenOptions {
  url?: string;
  /** Verzeichnis für PGlite, "memory" für eine flüchtige Datenbank (Tests) */
  dir?: string;
}

export async function openDb(opts: OpenOptions = {}): Promise<Db> {
  const url = opts.url ?? config.databaseUrl;
  current = url ? await openPg(url) : await openPglite(opts.dir ?? config.pgliteDir);
  return current;
}

export async function closeDb(): Promise<void> {
  if (current) {
    await current.close();
    current = null;
  }
}

async function openPg(url: string): Promise<Db> {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_SIZE ?? 10) });
  pool.on('error', (err) => log.error('Fehler im Datenbankpool', { err: errMsg(err) }));
  await pool.query('select 1');
  log.info('Datenbank verbunden', { kind: 'postgres' });
  return {
    kind: 'pg',
    async query(sql, params) {
      return (await pool.query(sql, params)).rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn({
          async query(sql, params) {
            return (await client.query(sql, params)).rows;
          },
        });
        await client.query('commit');
        client.release();
        return out;
      } catch (e) {
        // eine Verbindung, die nicht einmal zurückrollen kann, verwirft der Pool statt sie weiterzugeben
        const rollbackError = await client.query('rollback').then(
          () => undefined,
          (err: Error) => err,
        );
        client.release(rollbackError);
        throw e;
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir !== 'memory') mkdirSync(dir, { recursive: true });
  const pgl = dir === 'memory' ? await PGlite.create() : await PGlite.create(dir);
  log.info('Datenbank geöffnet', { kind: 'pglite', dir });
  return {
    kind: 'pglite',
    async query(sql, params) {
      return (await pgl.query(sql, params)).rows as any[];
    },
    async exec(sql) {
      await pgl.exec(sql);
    },
    async tx(fn) {
      return pgl.transaction(async (t) =>
        fn({
          async query(sql, params) {
            return (await t.query(sql, params)).rows as any[];
          },
        }),
      );
    },
    async close() {
      await pgl.close();
    },
  };
}
