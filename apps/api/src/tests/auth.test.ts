import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { authMiddleware, parseAuthorizedParties } from '../auth';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';

const testApp = () => {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', authMiddleware);
  app.get('/private', (c) => c.json({ ok: true }));
  app.onError((error, c) =>
    error instanceof HttpError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: 'internal' }, 500),
  );
  return app;
};

const env = { CLERK_SECRET_KEY: 'test-secret', DB: {} as D1Database };

describe('Clerk token configuration', () => {
  it('ignores empty authorized-party configuration values', () => {
    expect(parseAuthorizedParties(undefined)).toBeUndefined();
    expect(parseAuthorizedParties('')).toBeUndefined();
    expect(parseAuthorizedParties(' , https://walden.test, ')).toEqual(['https://walden.test']);
  });

  it('requires a Clerk bearer token', async () => {
    const response = await testApp().fetch(new Request('https://walden.test/private'), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Authentication required' });
  });

  it('rejects malformed bearer tokens without guest fallback', async () => {
    const response = await testApp().fetch(
      new Request('https://walden.test/private', { headers: { authorization: 'Bearer invalid' } }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid authentication token' });
  });
});
