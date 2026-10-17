import { verifyToken } from '@clerk/backend';
import type { Context, MiddlewareHandler } from 'hono';
import { getAuth } from './auth/better-auth';

export type { AppAuth } from './auth/better-auth';

import { ensureAppUser, readAuthMode, requireAcceptedAuthMode } from './auth/state';
import { HttpError } from './http';

export { readAuthMode } from './auth/state';

import type { Bindings, Variables } from './types';

export const parseAuthorizedParties = (value: string | undefined): string[] | undefined => {
  const parties = value
    ?.split(',')
    .map((party) => party.trim())
    .filter(Boolean);
  return parties?.length ? parties : undefined;
};

const verificationReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('expired')) return 'expired';
  if (message.includes('authorized party') || message.includes('azp')) return 'authorized_party';
  if (message.includes('signature')) return 'signature';
  if (message.includes('jwk') || message.includes('key')) return 'key_resolution';
  if (message.includes('not active') || message.includes('nbf')) return 'not_active';
  return 'invalid';
};

/** Reject ambient browser requests from other sites, including no-auth installations. */
const publicOrigin = (request: Request, appUrl?: string) => {
  if (appUrl === undefined) return new URL(request.url).origin;
  try {
    const url = new URL(appUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(503, 'APP_URL must be an HTTP or HTTPS origin');
  }
};

export const requireSameOrigin = (request: Request, appUrl?: string) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if ((origin && origin !== publicOrigin(request, appUrl)) || fetchSite === 'cross-site')
    throw new HttpError(403, 'Cross-origin mutations are not allowed');
};

/** A cookie or provider switch must not send an old workspace's data into a new account. */
const requireAccountIdentity = (c: Context<{ Bindings: Bindings; Variables: Variables }>) => {
  const expected = c.req.header('X-Walden-Account-Id');
  if (expected !== undefined && expected !== c.get('userId'))
    throw new HttpError(409, 'Your account changed. Reload Walden before continuing.', {
      code: 'auth_identity_changed',
      action: 'reload',
    });
};

export const authMiddleware: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  const mode = readAuthMode(c.env);
  // Keep malformed/absent Clerk credentials a 401 even before touching the database.
  if (mode === 'none') {
    requireSameOrigin(c.req.raw, c.env.APP_URL);
    await requireAcceptedAuthMode(c.env.DB, mode);
    const userId = await ensureAppUser(c.env.DB, mode, 'default');
    c.set('userId', userId);
    c.set('authSubject', userId);
    requireAccountIdentity(c);
    await next();
    return;
  }
  if (mode === 'better-auth') {
    requireSameOrigin(c.req.raw, c.env.APP_URL);
    await requireAcceptedAuthMode(c.env.DB, mode);
    const auth = await getAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HttpError(401, 'Authentication required');
    c.set('userId', await ensureAppUser(c.env.DB, mode, session.user.id));
    c.set('authSubject', session.user.id);
    requireAccountIdentity(c);
    await next();
    return;
  }
  let subject: string;
  const authorization = c.req.header('authorization');
  if (authorization === undefined) {
    if (!c.env.CLERK_SECRET_KEY) throw new HttpError(401, 'Authentication is not configured');
    throw new HttpError(401, 'Authentication required');
  }
  if (!authorization.startsWith('Bearer ') || !c.env.CLERK_SECRET_KEY)
    throw new HttpError(401, 'Invalid authentication token');
  const token = authorization.slice(7).trim();
  if (!token) throw new HttpError(401, 'Invalid authentication token');
  try {
    const payload = await verifyToken(token, {
      secretKey: c.env.CLERK_SECRET_KEY,
      authorizedParties: parseAuthorizedParties(c.env.CLERK_AUTHORIZED_PARTIES),
    });
    if (!payload.sub) throw new Error('Missing subject');
    subject = payload.sub;
  } catch (error) {
    console.warn('Clerk token verification failed', { reason: verificationReason(error) });
    throw new HttpError(401, 'Invalid authentication token');
  }

  await requireAcceptedAuthMode(c.env.DB, mode);
  const userId = await ensureAppUser(c.env.DB, mode, subject);
  c.set('userId', userId);
  c.set('authSubject', subject);
  requireAccountIdentity(c);
  await next();
};

export const getAccountIdentity = (c: Context<{ Bindings: Bindings; Variables: Variables }>) => ({
  id: c.get('userId'),
  authMode: readAuthMode(c.env),
});
