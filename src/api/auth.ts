import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { db, one, type Queryable } from '../db/index.js';
import { hashPassword, randomId, signToken, verifyPassword, verifyToken } from '../lib/crypto.js';
import { parseJsonBody } from '../lib/http.js';
import { getSiteById, type Site } from '../sites.js';

export const SESSION_COOKIE = 'bzf_session';
export const SESSION_TTL = 14 * 24 * 3600;

// Für unbekannte Mailadressen wird gegen diesen Hash gerechnet, damit die Antwortzeit nichts verrät
const UNKNOWN_USER_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  workspaceIds: string[];
}

export type AppEnv = { Variables: { user: AuthUser } };

export async function createWorkspace(q: Queryable, name: string): Promise<string> {
  const id = randomId('ws_', 9);
  await q.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
  return id;
}

export async function createUser(
  q: Queryable,
  input: { email: string; password: string; name?: string; workspaceId: string; role?: string },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 10) throw new Error('Passwort muss mindestens 10 Zeichen haben');
  let user = await one<{ id: string }>(q, 'select id from users where email = $1', [email]);
  if (!user) {
    const id = randomId('u_', 9);
    await q.query('insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)', [
      id,
      email,
      input.name ?? null,
      await hashPassword(input.password),
    ]);
    user = { id };
  }
  await q.query(
    `insert into memberships (workspace_id, user_id, role) values ($1,$2,$3)
     on conflict (workspace_id, user_id) do update set role = excluded.role`,
    [input.workspaceId, user.id, input.role ?? 'owner'],
  );
  return user.id;
}

async function loadUser(q: Queryable, id: string, issuedAt?: number): Promise<AuthUser | null> {
  const user = await one<{ id: string; email: string; name: string | null; sessions_revoked_at: Date | null }>(
    q,
    'select id, email, name, sessions_revoked_at from users where id = $1',
    [id],
  );
  if (!user) return null;
  // Abmelden entwertet alle bis dahin ausgestellten Sitzungen dieses Nutzers
  if (issuedAt !== undefined && user.sessions_revoked_at && issuedAt <= new Date(user.sessions_revoked_at).getTime()) return null;
  const memberships = await q.query<{ workspace_id: string }>('select workspace_id from memberships where user_id = $1', [id]);
  return { id: user.id, email: user.email, name: user.name, workspaceIds: memberships.map((m) => m.workspace_id) };
}

export async function revokeSessions(q: Queryable, userId: string) {
  await q.query('update users set sessions_revoked_at = $2 where id = $1', [userId, new Date()]);
}

export async function login(q: Queryable, email: string, password: string): Promise<{ user: AuthUser; token: string } | null> {
  const account = await one<{ id: string; password_hash: string }>(q, 'select id, password_hash from users where email = $1', [
    email.trim().toLowerCase(),
  ]);
  const ok = await verifyPassword(password, account?.password_hash ?? UNKNOWN_USER_HASH);
  if (!account || !ok) return null;
  await q.query('update users set last_login_at = now() where id = $1', [account.id]);
  const user = await loadUser(q, account.id);
  if (!user) return null;
  return { user, token: signToken({ uid: account.id, iat: Date.now() }, SESSION_TTL) };
}

/** Schützt /api/*, schreibende Anfragen brauchen zusätzlich den Header x-bezzify gegen CSRF */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = verifyToken<{ uid: string; iat?: number }>(getCookie(c, SESSION_COOKIE));
  if (!token) return c.json({ error: 'Nicht angemeldet' }, 401);
  if (c.req.method !== 'GET' && c.req.header('x-bezzify') !== '1') {
    return c.json({ error: 'Header x-bezzify fehlt' }, 403);
  }
  const user = await loadUser(db(), token.uid, token.iat ?? 0);
  if (!user) return c.json({ error: 'Nicht angemeldet' }, 401);
  c.set('user', user);
  await next();
};

export class HttpStatusError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  try {
    return parseJsonBody(text);
  } catch {
    throw new HttpStatusError(400, 'Kein gültiges JSON');
  }
}

export async function requireSite(c: Context<AppEnv>, siteId?: string | null): Promise<Site> {
  const id = siteId ?? c.req.query('site') ?? c.req.param('id');
  if (!id) throw new HttpStatusError(400, 'Parameter site fehlt');
  const site = await getSiteById(db(), id);
  const user = c.get('user');
  if (!site || !user.workspaceIds.includes(site.workspaceId)) throw new HttpStatusError(404, 'Shop nicht gefunden');
  return site;
}
