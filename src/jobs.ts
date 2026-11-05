import { config } from './config.js';
import type { Db } from './db/index.js';
import { processOutbox } from './integrations/outbox.js';
import { syncAllCosts } from './integrations/sync.js';
import { errMsg, log } from './lib/log.js';

const OUTBOX_BATCH = 50;
const running = new Set<string>();

// Mit Postgres hält ein Advisory Lock auf Transaktionsebene den Job auch über mehrere Instanzen hinweg exklusiv
async function runExclusive(database: Db, name: string, lockId: number, job: () => Promise<void>) {
  if (running.has(name)) return;
  running.add(name);
  try {
    if (database.kind === 'pglite') {
      await job();
    } else {
      await database.tx(async (tx) => {
        const [lock] = await tx.query<{ ok: boolean }>('select pg_try_advisory_xact_lock($1) as ok', [lockId]);
        if (lock?.ok) await job();
      });
    }
  } catch (e) {
    log.error('Job fehlgeschlagen', { job: name, err: errMsg(e) });
  } finally {
    running.delete(name);
  }
}

export async function cleanup(database: Db) {
  // match_data_at bleibt stehen, daran erkennt upsertOrder die Löschung und speichert nie wieder Merkmale
  await database.query(
    `update orders set match_data = null where match_data is not null and match_data_at < now() - make_interval(days => $1)`,
    [config.matchDataRetentionDays],
  );
  await database.query('delete from events where ts < now() - make_interval(days => $1)', [config.retentionDays]);
  await database.query('delete from sessions where last_seen_at < now() - make_interval(days => $1)', [config.retentionDays]);
  await database.query('delete from identities where last_seen < now() - make_interval(days => $1)', [config.retentionDays]);
  await database.query(`delete from outbox where status <> 'pending' and created_at < now() - interval '90 days'`);
  await database.query('delete from survey_answers where created_at < now() - make_interval(days => $1)', [config.retentionDays]);
  // zu einer Antwort ohne passende Bestellung nach einer Woche kommt keine mehr, meist war der Checkout Token geraten
  await database.query(
    `delete from survey_answers a where a.created_at < now() - interval '7 days'
       and not exists (
         select 1 from orders o where o.site_id = a.site_id
           and ((a.ref like 'order:%' and o.external_id = substr(a.ref, 7))
             or (a.ref like 'checkout:%' and o.checkout_token = substr(a.ref, 10))))`,
  );
}

export function startJobs(database: Db): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (intervalMs: number, firstMs: number, name: string, lockId: number, job: () => Promise<void>) => {
    timers.push(setTimeout(() => void runExclusive(database, name, lockId, job), firstMs));
    timers.push(setInterval(() => void runExclusive(database, name, lockId, job), intervalMs));
  };
  every(30_000, 10_000, 'outbox', 7101, async () => {
    let processed: number;
    do {
      processed = await processOutbox(database, { limit: OUTBOX_BATCH });
    } while (processed === OUTBOX_BATCH);
  });
  every(60 * 60_000, 60_000, 'costs', 7102, async () => {
    await syncAllCosts(database);
  });
  every(6 * 60 * 60_000, 5 * 60_000, 'cleanup', 7103, () => cleanup(database));
  log.info('Hintergrundjobs gestartet');
  return () => timers.forEach((timer) => clearTimeout(timer));
}
