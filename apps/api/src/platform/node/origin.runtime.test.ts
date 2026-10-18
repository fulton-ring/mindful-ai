import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createAccount } from '../../auth/admin';
import { readNodeConfig } from './config';
import { createNodeRuntime } from './runtime';

const test = process.env.EMBEDDING_MODEL_DIR ? it : it.skip;
async function fixture(mode: 'none' | 'better-auth') {
  const dataDir = await mkdtemp(join(tmpdir(), 'walden-proxy-origin-'));
  const config = readNodeConfig({
    APP_ROOT: resolve('.'),
    DATA_DIR: dataDir,
    APP_URL: 'https://walden.example',
    EMBEDDING_MODEL_DIR: process.env.EMBEDDING_MODEL_DIR,
  });
  const runtime = await createNodeRuntime(config, {
    environment: {
      AUTH_MODE: mode,
      BETTER_AUTH_SECRET: 'reverse-proxy-test-secret-long-enough-12345',
      AUTH_ADMIN_SECRET: 'reverse-proxy-admin-secret-long-enough-12345',
    },
  });
  let cookie: string | undefined;
  const request = (
    path: string,
    body: unknown,
    origin = 'https://walden.example',
    secret?: string,
  ) =>
    runtime.fetch(
      new Request(`http://backend:3000${path}`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  return {
    runtime,
    request,
    async signIn() {
      await createAccount(runtime.env, {
        email: 'proxy-owner@example.test',
        name: 'Owner',
        password: 'proxy-owner-password-123',
      });
      const login = await request('/api/auth/sign-in/email', {
        email: 'proxy-owner@example.test',
        password: 'proxy-owner-password-123',
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    },
    async close() {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
for (const mode of ['none', 'better-auth'] as const)
  test(`accepts public HTTPS origin over backend HTTP in ${mode} mode`, async () => {
    const context = await fixture(mode);
    const { runtime, request } = context;
    try {
      if (mode === 'better-auth') {
        await context.signIn();
        expect((await request('/api/auth/sign-out', {}, 'https://evil.example')).status).toBe(403);
      }
      expect((await request('/api/notes', { markdown: 'Saved behind a proxy.' })).status).toBe(201);
      expect(
        (await request('/api/notes', { markdown: 'Blocked.' }, 'https://evil.example')).status,
      ).toBe(403);
      expect(
        (
          await request(
            '/api/auth/admin',
            { command: 'accept-mode', mode },
            'https://evil.example',
            runtime.env.AUTH_ADMIN_SECRET,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            '/api/auth/admin',
            { command: 'accept-mode', mode },
            'https://walden.example',
            runtime.env.AUTH_ADMIN_SECRET,
          )
        ).status,
      ).toBe(200);
    } finally {
      await context.close();
    }
  });
