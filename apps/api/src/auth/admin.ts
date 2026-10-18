import { z } from 'zod';
import { HttpError, nowIso } from '../http';
import type { Bindings } from '../types';
import { getAuth } from './better-auth';
import type { AuthMode } from './state';
import { ensureAppUser } from './state';
export async function acceptAuthMode(db: Bindings['DB'], mode: AuthMode) {
  if (!['none', 'clerk', 'better-auth'].includes(mode))
    throw new HttpError(400, 'Invalid authentication mode');
  const settings = db
    .prepare(
      "INSERT INTO app_settings(key,value) VALUES('accepted_auth_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(mode);
  const revoke = db.prepare(
    "DELETE FROM auth_session WHERE EXISTS (SELECT 1 FROM app_settings WHERE key='accepted_auth_mode' AND value='better-auth')",
  );
  await db.batch(mode === 'better-auth' ? [settings] : [revoke, settings]);
}
/** Explicit owner id is required: never claim by first login or matching email. */
export async function claimDefaultAccount(db: Bindings['DB'], ownerId: string, authUserId: string) {
  const user = await db.prepare('SELECT id FROM auth_user WHERE id=?').bind(authUserId).first();
  if (!user) throw new HttpError(404, 'Local authentication user not found');
  const owner = await db
    .prepare("SELECT id FROM users WHERE id=? AND auth_provider='none' AND auth_subject='default'")
    .bind(ownerId)
    .first();
  if (!owner)
    throw new HttpError(409, 'The specified account is not the unclaimed default account');
  const bound = await db
    .prepare("SELECT id FROM users WHERE auth_provider='better-auth' AND auth_subject=?")
    .bind(authUserId)
    .first();
  if (bound)
    throw new HttpError(
      409,
      'Authentication user already owns an account; automatic account merging is disabled',
    );
  const result = await db
    .prepare(
      "UPDATE users SET auth_provider='better-auth',auth_subject=?,updated_at=? WHERE id=? AND auth_provider='none' AND auth_subject='default'",
    )
    .bind(authUserId, nowIso(), ownerId)
    .run();
  if (!result.meta.changes) throw new HttpError(409, 'Default account was already claimed');
  await db.prepare('DELETE FROM auth_session WHERE user_id=?').bind(authUserId).run();
  return { id: ownerId, authUserId };
}

const credentials = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
  name: z.string().trim().min(1).max(200),
});
export type CreateAccountInput = z.input<typeof credentials>;
export async function createAccount(env: Bindings, input: CreateAccountInput) {
  const parsed = credentials.safeParse(input);
  if (!parsed.success)
    throw new HttpError(400, 'Provide a valid email, name, and password of 12 to 128 characters');
  const auth = await getAuth(env);
  const context = await auth.$context;
  if (await context.internalAdapter.findUserByEmail(parsed.data.email))
    throw new HttpError(409, 'Email already exists');
  const password = await context.password.hash(parsed.data.password);
  const user = await context.internalAdapter.createUser(
    { email: parsed.data.email, name: parsed.data.name, emailVerified: true },
    { method: 'admin' },
  );
  try {
    await context.internalAdapter.linkAccount({
      providerId: 'credential',
      accountId: user.id,
      userId: user.id,
      password,
    });
  } catch (error) {
    await context.internalAdapter.deleteUser(user.id);
    throw error;
  }
  return { authUserId: user.id };
}
export async function bootstrapAccount(env: Bindings, input: CreateAccountInput) {
  const any = await env.DB.prepare('SELECT id FROM auth_user LIMIT 1').first();
  if (any)
    throw new HttpError(409, 'Local authentication is already bootstrapped; use create-account');
  const created = await createAccount(env, input);
  const id = await ensureAppUser(env.DB, 'better-auth', created.authUserId);
  await acceptAuthMode(env.DB, 'better-auth');
  return { id, ...created };
}
export async function resetAccountPassword(env: Bindings, authUserId: string, password: string) {
  if (password.length < 12 || password.length > 128)
    throw new HttpError(400, 'Password must contain 12 to 128 characters');
  const context = await (await getAuth(env)).$context;
  if (!(await context.internalAdapter.findUserById(authUserId)))
    throw new HttpError(404, 'Local authentication user not found');
  if (!(await context.internalAdapter.findCredentialAccount(authUserId)))
    throw new HttpError(409, 'User has no password credential');
  const hashed = await context.password.hash(password);
  // Revoke first: a partial failure must never leave a prior session valid.
  await context.internalAdapter.deleteUserSessions(authUserId);
  await context.internalAdapter.updatePassword(authUserId, hashed);
  return { authUserId };
}
export const adminCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('bootstrap'),
    email: z.string(),
    password: z.string(),
    name: z.string(),
  }),
  z.object({
    command: z.literal('create-account'),
    email: z.string(),
    password: z.string(),
    name: z.string(),
  }),
  z.object({
    command: z.literal('reset-password'),
    authUserId: z.string().min(1),
    password: z.string(),
  }),
  z.object({
    command: z.literal('claim-default'),
    ownerId: z.string().min(1),
    authUserId: z.string().min(1),
  }),
  z.object({ command: z.literal('accept-mode'), mode: z.enum(['none', 'clerk', 'better-auth']) }),
]);
export async function runAuthAdminCommand(env: Bindings, input: unknown) {
  const parsed = adminCommandSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'Invalid authentication administration command');
  const command = parsed.data;
  switch (command.command) {
    case 'bootstrap':
      return bootstrapAccount(env, command);
    case 'create-account':
      return createAccount(env, command);
    case 'reset-password':
      return resetAccountPassword(env, command.authUserId, command.password);
    case 'claim-default':
      return claimDefaultAccount(env.DB, command.ownerId, command.authUserId);
    case 'accept-mode':
      await acceptAuthMode(env.DB, command.mode);
      return { mode: command.mode };
  }
}
