import { HttpError, nowIso } from '../http';
import type { Bindings } from '../types';
export type AuthMode = 'none' | 'clerk' | 'better-auth';
export type AuthConfiguration = Pick<
  Bindings,
  'CLERK_SECRET_KEY' | 'CLERK_PUBLISHABLE_KEY' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL'
> & {
  AUTH_MODE?: string;
};
export function readAuthMode(env: AuthConfiguration): AuthMode {
  const configured = env.AUTH_MODE?.trim();
  if (configured && !['none', 'clerk', 'better-auth'].includes(configured))
    throw new HttpError(503, 'AUTH_MODE must be none, clerk, or better-auth');
  // Operators can prepare credentials before explicitly claiming a no-auth workspace.
  if (configured === 'none') return 'none';
  const clerk = Boolean(env.CLERK_SECRET_KEY || env.CLERK_PUBLISHABLE_KEY);
  const local = Boolean(env.BETTER_AUTH_SECRET || env.BETTER_AUTH_URL);
  const completeLocal = Boolean(env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL);
  if (!configured && clerk && local)
    throw new HttpError(
      503,
      'Multiple authentication providers are configured; set AUTH_MODE explicitly',
    );
  if (!configured && Boolean(env.CLERK_SECRET_KEY) !== Boolean(env.CLERK_PUBLISHABLE_KEY))
    throw new HttpError(
      503,
      'Incomplete Clerk configuration; set both Clerk keys or explicitly choose AUTH_MODE',
    );
  // Explicit Better Auth allows Node composition to default its URL from APP_URL.
  if (local && !completeLocal && !(configured === 'better-auth' && env.BETTER_AUTH_SECRET))
    throw new HttpError(
      503,
      'Incomplete Better Auth configuration; set BETTER_AUTH_SECRET and BETTER_AUTH_URL or explicitly choose AUTH_MODE=none',
    );
  const mode = (configured ||
    (completeLocal ? 'better-auth' : clerk ? 'clerk' : 'none')) as AuthMode;
  if (mode === 'clerk' && (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY))
    throw new HttpError(503, 'Clerk authentication requires both Clerk keys');
  return mode;
}
export async function requireAcceptedAuthMode(db: Bindings['DB'], mode: AuthMode) {
  let state = await db
    .prepare("SELECT value FROM app_settings WHERE key='accepted_auth_mode'")
    .first<{ value: string }>();
  if (!state) {
    // Existing private deployments must never become public because secrets were omitted.
    const existing = await db
      .prepare("SELECT id FROM users WHERE auth_provider <> 'none' LIMIT 1")
      .first();
    const initial = existing ? 'clerk' : mode;
    await db
      .prepare(
        "INSERT INTO app_settings(key,value) VALUES('accepted_auth_mode',?) ON CONFLICT(key) DO NOTHING",
      )
      .bind(initial)
      .run();
    state = await db
      .prepare("SELECT value FROM app_settings WHERE key='accepted_auth_mode'")
      .first<{ value: string }>();
  }
  if (state?.value !== mode)
    throw new HttpError(
      503,
      'Authentication mode changed; an operator must explicitly accept the new mode',
    );
}
export async function ensureAppUser(
  db: Bindings['DB'],
  provider: AuthMode,
  subject: string,
): Promise<string> {
  let user = await db
    .prepare('SELECT id FROM users WHERE auth_provider=? AND auth_subject=?')
    .bind(provider, subject)
    .first<{ id: string }>();
  if (!user) {
    const now = nowIso();
    await db
      .prepare(
        'INSERT INTO users(id,auth_provider,auth_subject,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(auth_provider,auth_subject) DO NOTHING',
      )
      .bind(crypto.randomUUID(), provider, subject, now, now)
      .run();
    user = await db
      .prepare('SELECT id FROM users WHERE auth_provider=? AND auth_subject=?')
      .bind(provider, subject)
      .first<{ id: string }>();
  }
  if (!user) throw new HttpError(500, 'Could not initialize account');
  return user.id;
}
