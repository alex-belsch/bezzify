import { closeDb, openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createUser, createWorkspace } from './api/auth.js';
import { processOutbox } from './integrations/outbox.js';
import { COST_FETCHERS, syncAllCosts, syncCosts } from './integrations/sync.js';
import { listIntegrations } from './integrations/store.js';
import { errMsg } from './lib/log.js';
import { addDays, zonedDay } from './lib/time.js';
import { config } from './config.js';
import { createSite, getSiteById, listAllSites, type Platform } from './sites.js';
import { seedDemo } from './demo.js';

type Args = Record<string, string[]>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = 'help', ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) continue;
    const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
    (args[flag.slice(2)] ??= []).push(value);
  }
  return { cmd, args };
}

function option(args: Args, name: string, required = true): string {
  const value = args[name]?.[0];
  if (!value && required) throw new Error(`--${name} fehlt`);
  return value ?? '';
}

const HELP = `Bezzify CLI

  migrate                         Datenbankschema anlegen oder aktualisieren
  setup                           Workspace, Shop und Login in einem Schritt anlegen
      --workspace "Meine Firma" --site "Mein Shop" --platform shopify
      --domain myshop.de [--domain myshop.myshopify.com] --email du@firma.de --password "..."
  user:create --workspace <id> --email <mail> --password <pw>
  site:create --workspace <id> --name <name> --platform shopify|shopware|woocommerce|custom --domain <domain>
  sites                           Shops mit Schlüsseln auflisten
  demo [--days 45] [--visitors 650] Demo Shop mit Beispieldaten anlegen
  sync [--site <id>] [--days 30]  Kosten jetzt importieren
  outbox                          fällige Rückspielungen jetzt senden
`;

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  if (cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }
  const db = await openDb();
  await migrate(db);
  try {
    switch (cmd) {
      case 'migrate':
        console.log('Schema ist aktuell.');
        break;
      case 'setup': {
        const workspaceId = await createWorkspace(db, option(args, 'workspace'));
        await createUser(db, { email: option(args, 'email'), password: option(args, 'password'), workspaceId });
        const { site, secretKey } = await createSite(db, {
          workspaceId,
          name: option(args, 'site'),
          platform: (option(args, 'platform', false) || 'custom') as Platform,
          domains: args.domain ?? [],
        });
        console.log(`Workspace ${workspaceId} und Shop ${site.id} angelegt.`);
        console.log(`Öffentlicher Site Key: ${site.publicKey}`);
        console.log(`Secret Key (nur jetzt sichtbar, für Server zu Server): ${secretKey}`);
        console.log(`Dashboard: ${config.publicUrl}`);
        break;
      }
      case 'user:create': {
        const userId = await createUser(db, {
          email: option(args, 'email'),
          password: option(args, 'password'),
          workspaceId: option(args, 'workspace'),
        });
        console.log(`Benutzer ${userId} angelegt.`);
        break;
      }
      case 'site:create': {
        const { site, secretKey } = await createSite(db, {
          workspaceId: option(args, 'workspace'),
          name: option(args, 'name'),
          platform: (option(args, 'platform', false) || 'custom') as Platform,
          domains: args.domain ?? [],
        });
        console.log(`Shop ${site.id} angelegt. Site Key ${site.publicKey}, Secret Key ${secretKey}`);
        break;
      }
      case 'sites': {
        for (const site of await listAllSites(db)) {
          console.log(`${site.id}  ${site.name}  ${site.platform}  ${site.domains.join(',')}  ${site.publicKey}`);
        }
        break;
      }
      case 'demo': {
        const days = Number(option(args, 'days', false) || 45);
        const visitorsPerDay = Number(option(args, 'visitors', false) || 650);
        const startedAt = Date.now();
        const demo = await seedDemo(db, { days, visitorsPerDay });
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`Demo angelegt in ${seconds} s: ${demo.sessions} Sessions, ${demo.orders} Bestellungen.`);
        console.log(`Login: ${demo.email} / ${demo.password}`);
        console.log(`Dashboard: ${config.publicUrl}`);
        break;
      }
      case 'sync': {
        const siteId = option(args, 'site', false);
        const days = Number(option(args, 'days', false) || 0);
        if (!siteId) {
          console.log(JSON.stringify(await syncAllCosts(db), null, 2));
          break;
        }
        const site = await getSiteById(db, siteId);
        if (!site) throw new Error('Shop nicht gefunden');
        const to = zonedDay(Date.now(), site.timezone);
        for (const integration of await listIntegrations(db, site.id)) {
          if (!COST_FETCHERS[integration.platform]) continue;
          const synced = await syncCosts(db, site, integration.platform, days ? { from: addDays(to, -(days - 1)), to } : {});
          console.log(JSON.stringify(synced));
        }
        break;
      }
      case 'outbox':
        console.log(`${await processOutbox(db, { limit: 500 })} Einträge verarbeitet.`);
        break;
      default:
        console.log(HELP);
    }
  } finally {
    await closeDb();
  }
}

main().catch((e: unknown) => {
  console.error(errMsg(e));
  process.exit(1);
});
