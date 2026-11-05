import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { errMsg, log } from './lib/log.js';
import { HttpStatusError } from './api/auth.js';
import { dashboardRoutes } from './api/dashboard.js';
import { publicRoutes } from './api/public.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Content-Security-Policy', CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
};

function dashboardIndex(): string {
  const file = join(config.dashboardDir, 'index.html');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  return `<!doctype html><meta charset="utf-8"><title>Bezzify</title>
<body style="font-family:system-ui;padding:40px">Das Dashboard ist noch nicht gebaut. Bitte <code>npm run build:dashboard</code> ausführen
oder für die Entwicklung <code>npm run dev:dashboard</code> starten.</body>`;
}

export function createApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpStatusError) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ error: 'Ungültige Eingabe', issues: err.issues }, 400);
    // etwa 413 aus bodyLimit
    if (err instanceof HTTPException) return err.getResponse();
    log.error('Unerwarteter Fehler', { path: c.req.path, err: errMsg(err) });
    return c.json({ error: 'Interner Fehler' }, 500);
  });

  app.route('/', publicRoutes());
  app.route('/api', dashboardRoutes());

  app.use('/assets/*', securityHeaders, serveStatic({ root: config.dashboardDir }));
  app.get('/favicon.svg', serveStatic({ path: join(config.dashboardDir, 'favicon.svg') }));
  app.get('/', securityHeaders, (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.html(dashboardIndex());
  });
  app.notFound((c) => c.json({ error: 'Nicht gefunden' }, 404));
  return app;
}
