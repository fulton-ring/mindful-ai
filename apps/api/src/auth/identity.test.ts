import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { sqliteD1Binding } from '../agent/memory/tests/d1-test-binding';
import { authMiddleware } from '../auth';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';
import { acceptAuthMode, createAccount } from './admin';
import { createBetterAuth } from './better-auth';
import { ensureAppUser } from './state';

function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'walden-identity-'));
  const file = join(directory, 'test.db');
  const native = new DatabaseSync(file);
  const migrations = new URL('../../migrations/', import.meta.url);
  native.exec(
    readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n'),
  );
  return {
    native,
    DB: sqliteD1Binding(file),
    cleanup() {
      native.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function cookieFor(env: Bindings, email: string, password: string) {
  const response = await env.AUTH!.handler(
    new Request('http://localhost:8787/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
function identityApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', authMiddleware);
  app.post('/mutate', async (c) => {
    await c.env.DB.prepare(
      "INSERT INTO notes(id,owner_id,created_at,updated_at,markdown) VALUES('new-note',?,'now','now','private draft')",
    )
      .bind(c.get('userId'))
      .run();
    return c.json({ ok: true });
  });
  app.get('/api/account', (c) => c.json({ id: c.get('userId') }));
  app.onError((e, c) =>
    e instanceof HttpError
      ? c.json({ error: e.message, details: e.details }, e.status)
      : c.json({ error: String(e) }, 500),
  );
  return app;
}
it('rejects stale account identity before mutations with real Better Auth account cookies', async () => {
  const fixture = databaseFixture();
  try {
    const env = {
      DB: fixture.DB,
      AUTH_MODE: 'better-auth',
      BETTER_AUTH_SECRET: 'identity-guard-test-secret-long-enough-123',
      BETTER_AUTH_URL: 'http://localhost:8787',
    } as Bindings;
    env.AUTH = createBetterAuth(fixture.native, env);
    await acceptAuthMode(env.DB, 'better-auth');
    const a = await createAccount(env, {
      email: 'alice@test.example',
      name: 'Alice',
      password: 'alice-password-for-test',
    });
    const b = await createAccount(env, {
      email: 'bob@test.example',
      name: 'Bob',
      password: 'bob-password-for-test',
    });
    const alice = await ensureAppUser(env.DB, 'better-auth', a.authUserId);
    const bob = await ensureAppUser(env.DB, 'better-auth', b.authUserId);
    const aliceCookie = await cookieFor(env, 'alice@test.example', 'alice-password-for-test');
    const cookie = await cookieFor(env, 'bob@test.example', 'bob-password-for-test');
    const app = identityApp();
    expect(
      (
        await app.request(
          'http://localhost:8787/api/account',
          { headers: { cookie: aliceCookie, 'X-Walden-Account-Id': alice } },
          env,
        )
      ).status,
    ).toBe(200);
    const request = (identity: string) =>
      app.request(
        'http://localhost:8787/mutate',
        {
          method: 'POST',
          headers: { cookie, origin: 'http://localhost:8787', 'X-Walden-Account-Id': identity },
        },
        env,
      );
    const stale = await request(alice);
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { details: { code: string; action: string } };
    expect(body.details).toEqual({
      code: 'auth_identity_changed',
      action: 'reload',
    });
    expect(await env.DB.prepare('SELECT id FROM notes').first()).toBeFalsy();
    expect((await request(bob)).status).toBe(200);
    expect(await env.DB.prepare('SELECT owner_id FROM notes').first()).toEqual({ owner_id: bob });
    expect(
      (await app.request('http://localhost:8787/api/account', { headers: { cookie } }, env)).status,
    ).toBe(200);
  } finally {
    fixture.cleanup();
  }
});
