import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { HttpError } from '../http';
import type { Bindings } from '../types';

const fields = {
  user: {
    modelName: 'auth_user',
    fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
  session: {
    modelName: 'auth_session',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    },
    cookieCache: { enabled: false },
  },
  account: {
    modelName: 'auth_account',
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    accountLinking: { enabled: false },
  },
  verification: {
    modelName: 'auth_verification',
    fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
} satisfies Partial<BetterAuthOptions>;
export type AuthSettings = { BETTER_AUTH_SECRET?: string; BETTER_AUTH_URL?: string };
export function createBetterAuth(
  database: BetterAuthOptions['database'],
  settings: AuthSettings,
  columnNames: 'sql' | 'drizzle' = 'sql',
) {
  const secret = settings.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new HttpError(503, 'BETTER_AUTH_SECRET must contain at least 32 characters');
  if (!settings.BETTER_AUTH_URL)
    throw new HttpError(503, 'BETTER_AUTH_URL is required for local authentication');
  let origin: string;
  try {
    const url = new URL(settings.BETTER_AUTH_URL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    origin = url.origin;
  } catch {
    throw new HttpError(503, 'BETTER_AUTH_URL must be an HTTP or HTTPS URL');
  }
  return betterAuth({
    database,
    secret,
    baseURL: origin,
    basePath: '/api/auth',
    trustedOrigins: [origin],
    ...fields,
    ...(columnNames === 'drizzle'
      ? {
          user: { ...fields.user, fields: {} },
          session: { ...fields.session, fields: {} },
          account: { ...fields.account, fields: {} },
          verification: { ...fields.verification, fields: {} },
        }
      : {}),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    advanced: { useSecureCookies: origin.startsWith('https:') },
  });
}
export type AppAuth = ReturnType<typeof createBetterAuth>;
/** Native D1 factory; portable AppDatabase wrappers are never assumed to be native D1. */
export function createD1Auth(database: D1Database, settings: AuthSettings): AppAuth {
  return createBetterAuth(database as BetterAuthOptions['database'], settings);
}
const cache = new WeakMap<object, AppAuth>();
export async function getAuth(env: Bindings): Promise<AppAuth> {
  if (env.AUTH) return env.AUTH;
  const cached = cache.get(env.DB);
  if (cached) return cached;
  const native = env.DB as unknown as D1Database;
  if (!('dump' in native))
    throw new HttpError(503, 'Local authentication was not initialized by the runtime');
  const auth = createD1Auth(native, env);
  cache.set(env.DB, auth);
  return auth;
}
