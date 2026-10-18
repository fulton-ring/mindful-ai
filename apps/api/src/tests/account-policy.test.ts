import { DEFAULT_APP_POLICY } from '@walden/contracts';
import { afterEach, expect, it } from 'vitest';
import { app } from '../index';
import { openSqliteDatabase, type SqliteDatabase } from '../platform/node/sqlite';
import { applySqliteMigrations } from '../platform/node/sqlite-migrations';
import type { Bindings } from '../types';

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const DB = openSqliteDatabase(':memory:');
  databases.push(DB);
  await applySqliteMigrations(DB, new URL('../../migrations/', import.meta.url));
  return { DB, AUTH_MODE: 'none' } as Bindings;
}

it('runs without billing, plans or authentication setup and exposes the default policy', async () => {
  const env = await fixture();
  const response = await app.request('/api/account/policy', {}, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ planId: 'default', policy: DEFAULT_APP_POLICY });
});

it('uses only the authenticated application account for optional entitlements', async () => {
  const env = await fixture();
  const identity = await app.request('/api/account', {}, env);
  const { id } = (await identity.json()) as { id: string };
  const seen: string[] = [];
  env.APP_PLANS_JSON = JSON.stringify({ premium: { messages: { limit: 80 } } });
  env.ENTITLEMENTS = {
    async getPlan(ownerId) {
      seen.push(ownerId);
      return 'premium';
    },
  };
  const response = await app.request('/api/account/policy?ownerId=other&planId=default', {}, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    planId: 'premium',
    policy: { messages: { limit: 80 } },
  });
  expect(seen).toHaveLength(1);
  expect(new Set(seen)).toEqual(new Set([id]));
  const stale = await app.request(
    '/api/account/policy',
    { headers: { 'X-Walden-Account-Id': 'other' } },
    env,
  );
  expect(stale.status).toBe(409);
});

it('keeps plan assignments out of public runtime configuration', async () => {
  const env = await fixture();
  env.APP_ACCOUNT_PLANS_JSON = '{"private-owner":"default"}';
  const response = await app.request('/api/config', {}, env);
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain('private-owner');
});
