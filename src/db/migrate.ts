import type { Db } from './index.js';
import { migrations } from './migrations.js';
import { log } from '../lib/log.js';

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set((await db.query<{ id: string }>('select id from schema_migrations')).map((r) => r.id));
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    // exec kennt keine Parameter, die ID ist eine Konstante aus migrations.ts
    await db.exec(`begin;\n${migration.sql}\ninsert into schema_migrations (id) values ('${migration.id}');\ncommit;`);
    applied.push(migration.id);
    log.info('Migration ausgeführt', { id: migration.id });
  }
  return applied;
}
