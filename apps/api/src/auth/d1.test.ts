import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, expect, it } from 'vitest';
import type { Bindings } from '../types';
import { bootstrapAccount, resetAccountPassword } from './admin';
import { getAuth } from './better-auth';

// Use Wrangler's installed Miniflare so this verifies the actual D1 binding, not a SQL mock.
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require(
  require.resolve('miniflare', { paths: [require.resolve('wrangler/package.json')] }),
);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: { DB: 'auth-test' },
    compatibilityDate: '2026-09-17',
  }),
);
afterAll(() => mf.dispose());
it('uses the native D1 adapter for real password and cookie-session flows', async () => {
  const DB = (await mf.getD1Database('DB')) as D1Database;
  const migrations = new URL('../../migrations/', import.meta.url);
  // D1 exec accepts one line per statement; migration SQL contains multiline trigger definitions.
  for (const name of readdirSync(migrations)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (const sql of readFileSync(new URL(name, migrations), 'utf8')
      .split('--> statement-breakpoint')
      .filter((sql) => sql.trim())) {
      await DB.prepare(sql).run();
    }
  }
  const env = {
    DB,
    AUTH_MODE: 'better-auth',
    BETTER_AUTH_SECRET: 'd1-real-test-secret-long-enough-123456',
    BETTER_AUTH_URL: 'http://localhost:8787',
  } as Bindings;
  env.AUTH = await getAuth(env);
  const account = await bootstrapAccount(env, {
    email: 'd1@test.example',
    name: 'D1 Owner',
    password: 'd1-owner-password-123',
  });
  const login = await env.AUTH.handler(
    new Request('http://localhost:8787/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' },
      body: JSON.stringify({ email: 'd1@test.example', password: 'd1-owner-password-123' }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await env.AUTH.api.getSession({ headers: new Headers({ cookie }) }))?.user.id).toBe(
    account.authUserId,
  );
  await resetAccountPassword(env, account.authUserId, 'd1-new-password-123');
  expect(await env.AUTH.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
});
