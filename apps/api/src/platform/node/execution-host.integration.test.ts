import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deleteAgentMemoryThread } from '../../agent/memory/memory';
import { deterministicModel } from '../../execution/fixture-model';
import { nativeAgentStream } from '../../execution/native-agent';
import { dockerTestCommand, dockerTestPort, removeTestContainers } from './docker-test';
import { createNodeExecutionHost } from './execution-host';
import { createPostgresDatabase } from './postgres';

const test = process.env.WALDEN_TEST_POSTGRES === '1' ? it : it.skip;
const prefix = `walden-native-test-${randomUUID()}`;
const containers: string[] = [];
let pool: Pool;
let dataDir: string;
let databaseUrl: string;
let valkeyUrl: string;
async function container(image: string, port: number, args: string[] = []) {
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
  if (process.env.WALDEN_TEST_POSTGRES !== '1') return;
  const port = await container('postgres:17-alpine', 5432, [
    '-e',
    'POSTGRES_PASSWORD=disposable-test',
  ]);
  databaseUrl = `postgres://postgres:disposable-test@127.0.0.1:${port}/postgres`;
  valkeyUrl = `redis://127.0.0.1:${await container('valkey/valkey:8-alpine', 6379)}`;
  pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 });
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
  dataDir = await mkdtemp(join(tmpdir(), 'walden-native-pg-'));
}, 90000);
afterAll(async () => {
  await pool?.end();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await removeTestContainers(containers);
}, 60000);
async function answer(
  host: Awaited<ReturnType<typeof createNodeExecutionHost>>['host'],
  runId: string,
) {
  const agent = new Agent({
    id: 'pg-host',
    name: 'PG host',
    instructions: 'Answer.',
    model: deterministicModel(),
  });
  const run = await nativeAgentStream(
    agent,
    'Hello',
    {},
    { host, runId, recover: false, generation: 1 },
  );
  expect(await run.output.text).toBe('Native answer.');
  await run.release();
}
test('initializes five PostgreSQL hosts concurrently against a fresh native schema', async () => {
  await pool.query('CREATE DATABASE native_startup');
  const url = new URL(databaseUrl);
  url.pathname = '/native_startup';
  const application = new Pool({ connectionString: url.toString() });
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, replica) =>
      createNodeExecutionHost({
        database: createPostgresDatabase(application),
        databaseUrl: url.toString(),
        dataDir: join(dataDir, `replica-${replica}`),
        ...(replica % 2 ? { valkeyUrl } : {}),
      }),
    ),
  );
  const hosts = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  try {
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    await Promise.all(hosts.map((host) => host.ready()));
    expect(hosts).toHaveLength(5);
    expect(
      (await application.query("SELECT indexname FROM pg_indexes WHERE schemaname='mastra'")).rows
        .length,
    ).toBeGreaterThan(0);
    expect(
      (
        await application.query(
          "SELECT count(*)::int AS total FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
        )
      ).rows[0].total,
    ).toBe(0);
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
    await application.end();
  }
}, 60000);
test('runs PostgreSQL native execution with local cache and no Valkey or pgvector', async () => {
  const database = createPostgresDatabase(pool);
  const runtime = await createNodeExecutionHost({ database, dataDir, databaseUrl });
  try {
    await runtime.ready();
    expect(runtime.host.pubsub).toBeUndefined();
    await database.transaction!((transaction) =>
      deleteAgentMemoryThread(transaction, 'memory-owner', 'memory-conversation', 'memory-branch'),
    );
    await answer(runtime.host, 'pg-local-cache');
    await runtime.host.cache.set('restart', { value: 1 });
  } finally {
    await runtime.close();
  }
  const restored = await createNodeExecutionHost({ database, dataDir, databaseUrl });
  try {
    expect(await restored.host.cache.get('restart')).toEqual({ value: 1 });
  } finally {
    await restored.close();
  }
  expect(
    (await pool.query("SELECT extname FROM pg_extension WHERE extname='vector'")).rowCount,
  ).toBe(0);
});
test('uses real Valkey atomic event cache and pubsub with PostgreSQL checkpoints', async () => {
  const runtime = await createNodeExecutionHost({
    database: createPostgresDatabase(pool),
    dataDir,
    databaseUrl,
    valkeyUrl,
  });
  try {
    await runtime.ready();
    expect(runtime.host.pubsub).toBeTruthy();
    expect(
      await runtime.host.cache.listPushIndexed('host:list', 'host:index', { chunk: 'hello' }),
    ).toBe(0);
    expect(await runtime.host.cache.listFromTo('host:list', 0)).toEqual([
      { index: 0, chunk: 'hello' },
    ]);
    await answer(runtime.host, 'pg-valkey-cache');
  } finally {
    await runtime.close();
  }
});
