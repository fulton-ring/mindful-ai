import { verifyToken } from '@clerk/backend';
import type { Context, MiddlewareHandler } from 'hono';
import { HttpError, nowIso } from './http';
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

export const ensureUser = async (
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  subject: string,
) => {
  let existing = await c.env.DB.prepare('SELECT id FROM users WHERE auth_subject = ?')
    .bind(subject)
    .first<{ id: string }>();
  if (!existing) {
    const now = nowIso();
    await c.env.DB.prepare(
      'INSERT INTO users (id, auth_subject, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(auth_subject) DO NOTHING',
    )
      .bind(crypto.randomUUID(), subject, now, now)
      .run();
    existing = await c.env.DB.prepare('SELECT id FROM users WHERE auth_subject = ?')
      .bind(subject)
      .first<{ id: string }>();
  }
  if (!existing) throw new HttpError(500, 'Could not initialize account');
  return existing.id;
};

export const authMiddleware: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
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

  const userId = await ensureUser(c, subject);
  c.set('userId', userId);
  c.set('authSubject', subject);
  await next();
};
