import { randomUUID } from 'node:crypto';
import { uiMessageText } from '@walden/contracts';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { dockerTestCommand, dockerTestPort, removeTestContainers } from './docker-test';
import { createNodeExecutionHost } from './execution-host';
import { createPostgresDatabase } from './postgres';
import { migratePostgres } from './postgres-migrations';
import { createNodeTurnRouter } from './turns';
import { type Cleanup, createTurnFixture } from './turns-fixtures';

const enabled = process.env.WALDEN_TEST_POSTGRES === '1';
const test = enabled ? it : it.skip;
const prefix = `walden-runner-test-${randomUUID()}`;
const containers: string[] = [];
const cleanup: Cleanup[] = [];
let pool: Pool;
let postgresUrl: string;
let valkeyUrl: string;
async function startContainer(image: string, port: number, args: string[] = []) {
  const name = `${prefix}-${port}`;
  containers.push(name);
  await dockerTestCommand([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    ...args,
    '-p',
    `127.0.0.1::${port}`,
    image,
  ]);
  return dockerTestPort(name, port);
}
beforeAll(async () => {
  if (!enabled) return;
  postgresUrl = `postgres://postgres:disposable-test@127.0.0.1:${await startContainer('postgres:17-alpine', 5432, ['-e', 'POSTGRES_PASSWORD=disposable-test'])}/postgres`;
  valkeyUrl = `redis://127.0.0.1:${await startContainer('valkey/valkey:8-alpine', 6379)}`;
  pool = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 1000, max: 4 });
  const deadline = Date.now() + 45000;
  while (true) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}, 90000);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(async () => {
  await pool?.end();
  await removeTestContainers(containers);
}, 60000);
async function fixture(name: 'completed' | 'stopped' | 'recovered', cacheDatabase: number) {
  await pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(postgresUrl);
  url.pathname = `/${name}`;
  const options = { databaseUrl: url.toString(), valkeyUrl: `${valkeyUrl}/${cacheDatabase}` };
  const appPool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 1000,
  });
  cleanup.push(() => appPool.end());
  await migratePostgres(appPool);
  const context = await createTurnFixture(cleanup, {
    database: createPostgresDatabase(appPool),
    ...options,
  });
  return { ...context, options };
}
async function waitForPartial(db: Awaited<ReturnType<typeof fixture>>['db']) {
  await expect
    .poll(
      async () =>
        (await db
          .prepare("SELECT COUNT(*) AS n FROM turn_events WHERE turn_id='turn'")
          .first<{ n: number }>())!.n,
      { timeout: 20000 },
    )
    .toBeGreaterThan(3);
}
test('commits a real provider turn through the shared PostgreSQL and Valkey runner', async () => {
  const { db, router, calls } = await fixture('completed', 1);
  const events = await (await router.router.get('turn').stream('turn', 0)).text();
  expect(events).toContain('Native answer.');
  expect(events).toContain('[DONE]');
  expect(calls()).toBe(1);
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({ status: 'completed', execution_generation: 1 });
  const message = await db
    .prepare("SELECT ui_message FROM messages WHERE id='turn'")
    .first<{ ui_message: string }>();
  expect(uiMessageText(JSON.parse(message!.ui_message))).toBe('Native answer.');
}, 60000);
test('persists PostgreSQL Stop before abort and preserves real partial provider output', async () => {
  const { db, router, setMode } = await fixture('stopped', 2);
  setMode('hold');
  const reading = (await router.router.get('turn').stream('turn', 0)).text();
  await waitForPartial(db);
  expect(await router.router.get('turn').stop('turn')).toBe(true);
  expect(
    await db.prepare("SELECT request_id FROM turn_cancellations WHERE owner_id='owner'").first(),
  ).toEqual({ request_id: 'request' });
  expect(await db.prepare("SELECT status FROM turns WHERE id='turn'").first()).toEqual({
    status: 'cancelled',
  });
  expect(await reading).toContain('Partial ');
}, 60000);
test('recovers a real PostgreSQL checkpoint after the native owner drains and restarts', async () => {
  const { db, env, directory, router, execution, setMode, calls, options } = await fixture(
    'recovered',
    3,
  );
  setMode('hold');
  const reading = (await router.router.get('turn').stream('turn', 0)).text();
  await waitForPartial(db);
  await router.close();
  await reading;
  await execution.close();
  expect(await db.prepare("SELECT status FROM turns WHERE id='turn'").first()).toEqual({
    status: 'streaming',
  });
  setMode('answer');
  const host = await createNodeExecutionHost({ database: db, dataDir: directory, ...options });
  cleanup.push(() => host.close());
  const next = createNodeTurnRouter(env, host.host, { execute: true, pollMs: 5 });
  cleanup.push(() => next.close());
  const events = await (await next.router.get('turn').stream('turn', 0)).text();
  expect(events).toContain('data-turn-replace');
  expect(events).toContain('Native answer.');
  expect(calls()).toBe(2);
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({ status: 'completed', execution_generation: 2 });
}, 90000);
