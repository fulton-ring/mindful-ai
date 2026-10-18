import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../agent/memory/tests/d1-test-binding';
import { authMiddleware, readAuthMode } from '../auth';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';
import { acceptAuthMode, claimDefaultAccount } from './admin';
import { mountAuthRoutes } from './routes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'walden-auth-'));
  dirs.push(dir);
  const file = join(dir, 'test.db');
  execFileSync('sqlite3', [
    file,
    `CREATE TABLE users(id TEXT PRIMARY KEY,auth_subject TEXT NOT NULL,created_at TEXT,updated_at TEXT,deletion_pending INTEGER DEFAULT 0,auth_provider TEXT NOT NULL DEFAULT 'clerk',UNIQUE(auth_provider,auth_subject)); CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE auth_user(id TEXT PRIMARY KEY,email TEXT); CREATE TABLE auth_session(id TEXT PRIMARY KEY,user_id TEXT);`,
  ]);
  const DB = sqliteD1Binding(file);
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  mountAuthRoutes(app);
  app.use('*', authMiddleware);
  app.get('/private', (c) => c.json({ id: c.get('userId') }));
  app.post('/private', (c) => c.json({ ok: true }));
  app.onError((e, c) =>
    e instanceof HttpError
      ? c.json({ error: e.message }, e.status)
      : c.json({ error: String(e) }, 500),
  );
  return { DB, app, env: { DB } as Bindings };
}
it('infers complete Better Auth credentials and rejects partial or ambiguous settings', () => {
  const local = {
    BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://walden.example',
  };
  expect(readAuthMode(local)).toBe('better-auth');
  expect(
    readAuthMode({ AUTH_MODE: 'better-auth', BETTER_AUTH_SECRET: local.BETTER_AUTH_SECRET }),
  ).toBe('better-auth');
  expect(
    readAuthMode({
      ...local,
      AUTH_MODE: 'clerk',
      CLERK_SECRET_KEY: 's',
      CLERK_PUBLISHABLE_KEY: 'p',
    }),
  ).toBe('clerk');
  expect(() => readAuthMode({ BETTER_AUTH_SECRET: local.BETTER_AUTH_SECRET })).toThrow(
    /Incomplete Better Auth/,
  );
  expect(() => readAuthMode({ BETTER_AUTH_URL: local.BETTER_AUTH_URL })).toThrow(
    /Incomplete Better Auth/,
  );
  expect(() =>
    readAuthMode({ ...local, CLERK_SECRET_KEY: 's', CLERK_PUBLISHABLE_KEY: 'p' }),
  ).toThrow(/AUTH_MODE/);
  expect(readAuthMode({ ...local, AUTH_MODE: 'none', CLERK_SECRET_KEY: 'partial' })).toBe('none');
  expect(readAuthMode({ AUTH_MODE: 'none', BETTER_AUTH_SECRET: 'preconfigure' })).toBe('none');
});
it('rolls session revocation back if accepting the new auth mode fails', async () => {
  const { DB } = fixture();
  await acceptAuthMode(DB, 'better-auth');
  await DB.prepare("INSERT INTO auth_session VALUES('session','user')").run();
  await DB.exec(
    "CREATE TRIGGER reject_mode BEFORE UPDATE ON app_settings WHEN NEW.value='none' BEGIN SELECT RAISE(ABORT,'mode change rejected'); END",
  );
  await expect(acceptAuthMode(DB, 'none')).rejects.toThrow(/mode change rejected/);
  expect(await DB.prepare('SELECT id FROM auth_session').first()).toEqual({ id: 'session' });
  expect(
    await DB.prepare("SELECT value FROM app_settings WHERE key='accepted_auth_mode'").first(),
  ).toEqual({ value: 'better-auth' });
});
describe('optional authentication', () => {
  it('defaults to none only with no partial Clerk configuration', () => {
    expect(readAuthMode({})).toBe('none');
    expect(() => readAuthMode({ CLERK_SECRET_KEY: 'partial' })).toThrow();
    expect(readAuthMode({ CLERK_SECRET_KEY: 's', CLERK_PUBLISHABLE_KEY: 'p' })).toBe('clerk');
    expect(() => readAuthMode({ AUTH_MODE: 'oops' })).toThrow();
  });
  it('persists a stable default identity and rejects cross-origin mutations', async () => {
    const { app, env } = fixture();
    const first = await app.request('https://walden.test/private', {}, env);
    expect(first.status).toBe(200);
    const id = ((await first.json()) as { id: string }).id;
    expect(await (await app.request('https://walden.test/private', {}, env)).json()).toEqual({
      id,
    });
    expect(
      (
        await app.request(
          'https://walden.test/private',
          { method: 'POST', headers: { origin: 'https://evil.test' } },
          env,
        )
      ).status,
    ).toBe(403);
  });
  it('requires explicit operator acceptance to change persisted authentication mode', async () => {
    const { app, env, DB } = fixture();
    await acceptAuthMode(DB, 'better-auth');
    expect((await app.request('https://walden.test/private', {}, env)).status).toBe(503);
    await acceptAuthMode(DB, 'none');
    expect((await app.request('https://walden.test/private', {}, env)).status).toBe(200);
  });
  it('never implicitly exposes existing Clerk accounts in none mode', async () => {
    const { app, env, DB } = fixture();
    await DB.prepare(
      "INSERT INTO users(id,auth_subject,auth_provider) VALUES('private','clerk-sub','clerk')",
    ).run();
    expect((await app.request('https://walden.test/private', {}, env)).status).toBe(503);
  });
  it('claims the default account only by explicit id and gives none a fresh account afterwards', async () => {
    const { app, env, DB } = fixture();
    const { id } = (await (await app.request('https://walden.test/private', {}, env)).json()) as {
      id: string;
    };
    await DB.prepare(
      "INSERT INTO auth_user(id,email) VALUES('local-auth','owner@test.example')",
    ).run();
    await claimDefaultAccount(DB, id, 'local-auth');
    const next = (await (await app.request('https://walden.test/private', {}, env)).json()) as {
      id: string;
    };
    expect(next.id).not.toBe(id);
    expect(
      await DB.prepare('SELECT auth_provider,auth_subject FROM users WHERE id=?').bind(id).first(),
    ).toEqual({ auth_provider: 'better-auth', auth_subject: 'local-auth' });
  });
});
it('keeps remote administration opt-in and requires the deployment secret', async () => {
  const { app, env, DB } = fixture();
  const command = { command: 'accept-mode', mode: 'better-auth' };
  const request = (secret?: string, origin = 'https://walden.test') =>
    app.request(
      'https://walden.test/api/auth/admin',
      {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(command),
      },
      env,
    );
  expect((await request()).status).toBe(404);
  env.AUTH_ADMIN_SECRET = 'deployment-admin-secret-at-least-32-characters';
  expect((await request('wrong')).status).toBe(401);
  expect((await request(env.AUTH_ADMIN_SECRET, 'https://evil.test')).status).toBe(403);
  expect((await request(env.AUTH_ADMIN_SECRET)).status).toBe(200);
  expect(
    await DB.prepare("SELECT value FROM app_settings WHERE key='accepted_auth_mode'").first(),
  ).toEqual({ value: 'better-auth' });
});
