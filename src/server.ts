import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startJobs } from './jobs.js';
import { log } from './lib/log.js';

async function main() {
  // früh scheitern, wenn der Schlüssel fehlt, nicht erst bei der ersten Anmeldung
  void config.appSecret;
  const database = await openDb();
  await migrate(database);
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('Bezzify läuft', { port: info.port, url: config.publicUrl });
  });
  const stopJobs = config.jobsEnabled ? startJobs(database) : () => {};

  const shutdown = async (signal: string) => {
    log.info('Beende', { signal });
    stopJobs();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
