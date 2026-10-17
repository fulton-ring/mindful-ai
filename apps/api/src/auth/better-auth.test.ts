import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { sqliteD1Binding } from '../agent/memory/tests/d1-test-binding';
import { authMiddleware } from '../auth';
import { HttpError } from '../http';
import { accountRoutes } from '../privacy/account';
import { researchOwnerScope } from '../services/research/research';
import type { Bindings, Variables } from '../types';
import { acceptAuthMode, bootstrapAccount, resetAccountPassword } from './admin';
import { createBetterAuth } from './better-auth';
import { mountAuthRoutes } from './routes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const natives: DatabaseSync[] = [];
afterEach(() => {
  for (const native of natives.splice(0)) native.close();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'walden-better-auth-'));
  dirs.push(dir);
  const file = join(dir, 'test.db');
  const native = new DatabaseSync(file);
  natives.push(native);
  const migrations = new URL('../../migrations/', import.meta.url);
  native.exec(
    readdirSync(migrations)
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .map((n) => readFileSync(new URL(n, migrations), 'utf8'))
      .join('\n'),
  );
  const DB = sqliteD1Binding(file);
  const env = {
    DB,
    AUTH_MODE: 'better-auth',
    BETTER_AUTH_SECRET: 'test-secret-long-enough-for-local-auth-1234',
    BETTER_AUTH_URL: 'http://localhost:8787',
  } as Bindings;
  const auth = createBetterAuth(native, env);
  env.AUTH = auth;
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  mountAuthRoutes(app);
  app.use('*', authMiddleware);
  app.route('/', accountRoutes);
  app.get('/private', (c) => c.json({ id: c.get('userId') }));
  app.onError((e, c) =>
    e instanceof HttpError
      ? c.json({ error: e.message }, e.status)
      : c.json({ error: String(e) }, 500),
  );
  const owner = await bootstrapAccount(env, {
    email: 'owner@test.example',
    password: 'a-very-long-password-123',
    name: 'Owner',
  });
  const request = (path: string, body: unknown, cookie?: string) =>
    app.request(
      `http://localhost:8787${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:8787',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    );
  return { DB, env, app, owner, request };
}

it('operator bootstrap signs in and public registration stays closed', async () => {
  const { request, app, env, owner } = await fixture();
  expect(
    (
      await request('/api/auth/sign-up/email', {
        email: 'intruder@test.example',
        password: 'a-very-long-password-123',
        name: 'Intruder',
      })
    ).status,
  ).toBe(404);
  const login = await request('/api/auth/sign-in/email', {
    email: 'owner@test.example',
    password: 'a-very-long-password-123',
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const response = await app.request('http://localhost:8787/private', { headers: { cookie } }, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: owner.id });
});
it('operator password reset revokes real cookie sessions and changes the credential', async () => {
  const { request, app, env, owner } = await fixture();
  const login = await request('/api/auth/sign-in/email', {
    email: 'owner@test.example',
    password: 'a-very-long-password-123',
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  await resetAccountPassword(env, owner.authUserId, 'replacement-password-123');
  expect(
    (await app.request('http://localhost:8787/private', { headers: { cookie } }, env)).status,
  ).toBe(401);
  expect(
    (
      await request('/api/auth/sign-in/email', {
        email: 'owner@test.example',
        password: 'a-very-long-password-123',
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request('/api/auth/sign-in/email', {
        email: 'owner@test.example',
        password: 'replacement-password-123',
      })
    ).status,
  ).toBe(200);
});
it('deletes the local authentication identity and all sessions with the app account', async () => {
  const { request, app, env, DB, owner } = await fixture();
  const deleteOwner = vi.fn().mockResolvedValue(undefined);
  env.SAVED_SOURCES = { deleteOwner } as unknown as Bindings['SAVED_SOURCES'];
  const login = await request('/api/auth/sign-in/email', {
    email: 'owner@test.example',
    password: 'a-very-long-password-123',
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect(
    (
      await app.request(
        'http://localhost:8787/account',
        { method: 'DELETE', headers: { cookie } },
        env,
      )
    ).status,
  ).toBe(204);
  expect(deleteOwner).toHaveBeenCalledWith(await researchOwnerScope(owner.id));
  expect(await DB.prepare('SELECT id FROM auth_user').first()).toBeFalsy();
  expect(await DB.prepare('SELECT id FROM auth_session').first()).toBeFalsy();
});

it('leaving Better Auth revokes real sessions before its mode can be re-enabled', async () => {
  const { request, app, env, DB } = await fixture();
  const login = await request('/api/auth/sign-in/email', {
    email: 'owner@test.example',
    password: 'a-very-long-password-123',
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  await acceptAuthMode(DB, 'better-auth');
  expect(
    (await app.request('http://localhost:8787/private', { headers: { cookie } }, env)).status,
  ).toBe(200);
  await acceptAuthMode(DB, 'none');
  expect(await DB.prepare('SELECT id FROM auth_session').first()).toBeFalsy();
  await acceptAuthMode(DB, 'better-auth');
  expect(
    (await app.request('http://localhost:8787/private', { headers: { cookie } }, env)).status,
  ).toBe(401);
});
