import type { MessageBudget, Usage } from '@walden/contracts';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { turnFixture } from '../../chat/turns/tests/turn-fixture';
import { HttpError } from '../../http';
import { getRequestAccountPolicy } from '../../policy/request';
import type { Bindings, Variables } from '../../types';
import { metricsRoutes } from '../routes';

async function fixture(resolveBeforeRoute = false) {
  const DB = await turnFixture();
  const startedAt = new Date().toISOString();
  await DB.prepare('INSERT INTO message_windows(owner_id,started_at,used) VALUES(?,?,?)')
    .bind('owner', startedAt, 7)
    .run();
  const env: Bindings = {
    DB,
    APP_DEFAULT_PLAN: 'small',
    APP_PLANS_JSON: JSON.stringify({
      small: { messages: { limit: 3, windowHours: 4 } },
      unlimited: { messages: { limit: null, windowHours: 4 } },
    }),
  };
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-owner') ?? 'owner');
    if (resolveBeforeRoute) await getRequestAccountPolicy(c);
    await next();
  });
  app.route('/api', metricsRoutes);
  app.onError((error, c) =>
    error instanceof HttpError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: 'internal' }, 500),
  );
  return { DB, env, app, startedAt };
}

it('reports owner-specific nullable budgets and usage without mixing account plans', async () => {
  const { DB, env, app, startedAt } = await fixture();
  await DB.prepare(
    "INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES('other','other','now','now')",
  ).run();
  env.APP_ACCOUNT_PLANS_JSON = JSON.stringify({ owner: 'unlimited', other: 'small' });
  const response = await app.request('/api/budget', {}, env);
  expect(response.status).toBe(200);
  const budget = {
    used: 7,
    limit: null,
    windowHours: 4,
    resetsAt: new Date(Date.parse(startedAt) + 4 * 60 * 60_000).toISOString(),
  };
  expect(await response.json()).toEqual(budget);
  const usage = await app.request('/api/usage', {}, env);
  expect(usage.status).toBe(200);
  expect(await usage.json()).toEqual({ budget, messagesSent: 1, favoritePersona: null });
  const other = await app.request(
    '/api/budget?ownerId=owner',
    { headers: { 'x-owner': 'other' } },
    env,
  );
  expect(await other.json()).toMatchObject({ used: 0, limit: 3, resetsAt: null });
});

it('reflects trusted entitlement plan changes while retaining the charged window', async () => {
  const { env, app } = await fixture();
  let plan = 'unlimited';
  const getPlan = vi.fn(async () => plan);
  env.ENTITLEMENTS = { getPlan };
  const before = (await (await app.request('/api/budget', {}, env)).json()) as MessageBudget;
  expect(before).toMatchObject({ used: 7, limit: null });
  plan = 'small';
  const after = (await (await app.request('/api/usage', {}, env)).json()) as Usage;
  expect(after.budget).toEqual({ ...before, limit: 3 });
  expect(getPlan.mock.calls).toEqual([['owner'], ['owner']]);
});

it('uses the same policy resolution as earlier request middleware', async () => {
  const { env, app } = await fixture(true);
  const getPlan = vi.fn(async () => 'unlimited');
  env.ENTITLEMENTS = { getPlan };
  const response = await app.request('/api/usage', {}, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ budget: { limit: null, used: 7 } });
  expect(getPlan.mock.calls).toEqual([['owner']]);
});

it('fails closed when the entitlement provider selects an unknown plan', async () => {
  const { env, app, DB } = await fixture();
  env.ENTITLEMENTS = { getPlan: async () => 'missing-plan' };
  for (const path of ['/api/budget', '/api/usage'])
    expect((await app.request(path, {}, env)).status).toBe(503);
  expect(
    await DB.prepare("SELECT used FROM message_windows WHERE owner_id='owner'").first(),
  ).toEqual({ used: 7 });
});
