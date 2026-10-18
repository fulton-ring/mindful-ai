import type { Hono } from 'hono';
import { requireSameOrigin } from '../auth';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';
import { runAuthAdminCommand } from './admin';
import { getAuth } from './better-auth';
import { readAuthMode, requireAcceptedAuthMode } from './state';

const routes = new Set([
  'sign-in/email',
  'sign-out',
  'get-session',
  'change-password',
  'list-sessions',
  'revoke-session',
  'revoke-other-sessions',
]);
async function sameSecret(left: string, right: string) {
  // Compare fixed-size digests instead of leaking the configured secret length or prefix.
  const digest = (value: string) =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i]! ^ y[i]!;
  return difference === 0;
}
/** Mount before the application authentication middleware; only explicit public login routes bypass it. */
export function mountAuthRoutes(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post('/api/auth/admin', async (c) => {
    if (!c.env.AUTH_ADMIN_SECRET || c.env.AUTH_ADMIN_SECRET.length < 32)
      throw new HttpError(404, 'Not found');
    requireSameOrigin(c.req.raw, c.env.APP_URL);
    const bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
    if (!bearer || !(await sameSecret(bearer, c.env.AUTH_ADMIN_SECRET)))
      throw new HttpError(401, 'Invalid operator credentials');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    return c.json(await runAuthAdminCommand(c.env, body));
  });
  app.all('/api/auth/*', async (c) => {
    const endpoint = c.req.path.slice('/api/auth/'.length);
    if (!routes.has(endpoint) || readAuthMode(c.env) !== 'better-auth')
      throw new HttpError(404, 'Not found');
    requireSameOrigin(c.req.raw, c.env.APP_URL);
    await requireAcceptedAuthMode(c.env.DB, 'better-auth');
    return (await getAuth(c.env)).handler(c.req.raw);
  });
}
