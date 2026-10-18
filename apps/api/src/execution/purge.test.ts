import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CONTROL_TOPIC, AGENT_STREAM_TOPIC } from '@mastra/core/agent/durable';
import { CachingPubSub, EventEmitterPubSub } from '@mastra/core/events';
import { afterEach, expect, it } from 'vitest';
import { createNodeExecutionHost } from '../platform/node/execution-host';
import { openSqliteDatabase } from '../platform/node/sqlite';
import { finishNativeRun, purgeNativeRun, sweepNativeRuns, trackNativeRun } from './purge';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const threadId = 'conversation:owner:conversation:branch:branch';
const resourceId = 'user:owner';
const descriptor = (runId = 'turn') => ({
  runId,
  ownerId: 'owner',
  conversationId: 'conversation',
  branchId: 'branch',
  deadlineAt: Date.now() + 60000,
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'walden-native-purge-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = openSqliteDatabase(join(directory, 'application.sqlite'));
  cleanup.push(() => db.close());
  await db.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,deletion_pending INTEGER NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,status TEXT,expires_at TEXT,retention_disabled INTEGER DEFAULT 0,last_user_activity_at TEXT);
    CREATE TABLE conversation_branches(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,owner_id TEXT,status TEXT);
    CREATE TABLE turns(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,status TEXT);
    INSERT INTO users VALUES('owner',0);
    INSERT INTO conversations VALUES('conversation','owner','active','2999-01-01',0,'2026-10-18T00:00:00.000Z');
    INSERT INTO conversation_branches VALUES('branch','conversation','owner','active');
    INSERT INTO turns VALUES('turn','conversation','completed');`);
  let runtime = await createNodeExecutionHost({ database: db, dataDir: directory });
  cleanup.push(() => runtime.close());
  const restart = async () => {
    await runtime.close();
    runtime = await createNodeExecutionHost({ database: db, dataDir: directory });
    return runtime.host;
  };
  return { db, host: runtime.host, restart };
}

async function sensitiveData(host: Awaited<ReturnType<typeof fixture>>['host']) {
  const workflows = (await host.storage.getStore('workflows'))!;
  await workflows.persistWorkflowSnapshot({
    workflowName: 'durable-agentic-loop',
    runId: 'turn',
    snapshot: {
      runId: 'turn',
      status: 'success',
      context: {
        sensitiveStep: {
          status: 'success',
          payload: {},
          output: { secret: 'private snapshot' },
          startedAt: 1,
          endedAt: 2,
        },
      },
      value: {},
      serializedStepGraph: [],
      activePaths: [],
      activeStepsPath: {},
      suspendedPaths: {},
      resumeLabels: {},
      waitingPaths: {},
      timestamp: Date.now(),
    },
  });
  await host.cache.set('walden:turn:turn:closures:v1', { secret: 'private closure' });
  const events = new CachingPubSub(new EventEmitterPubSub(), host.cache);
  for (const topic of [AGENT_STREAM_TOPIC('turn'), AGENT_CONTROL_TOPIC('turn')])
    await events.publish(topic, {
      type: 'chunk',
      runId: 'turn',
      data: { secret: 'private stream' },
    });
  const memory = (await host.storage.getStore('memory'))!;
  const now = new Date();
  await memory.saveThread({
    thread: { id: threadId, resourceId, title: 'Private thread', createdAt: now, updatedAt: now },
  });
  const record = await memory.initializeObservationalMemory({
    threadId,
    resourceId,
    scope: 'thread',
    config: {},
  });
  await memory.updateActiveObservations({
    id: record.id,
    observations: 'Private observation',
    tokenCount: 2,
    lastObservedAt: now,
  });
  return { workflows, memory, events };
}

it('purges expired native replay after one hour while preserving healthy conversation memory', async () => {
  const { db, host } = await fixture();
  const { workflows, memory, events } = await sensitiveData(host);
  await trackNativeRun(db, descriptor());
  await finishNativeRun(db, 'turn', Date.now() - 1);
  expect(await sweepNativeRuns(db, host)).toMatchObject({ purged: 1, failed: 0 });
  expect(
    await workflows.loadWorkflowSnapshot({ workflowName: 'durable-agentic-loop', runId: 'turn' }),
  ).toBeNull();
  expect(await host.cache.get('walden:turn:turn:closures:v1')).toBeUndefined();
  expect(await events.getHistory(AGENT_STREAM_TOPIC('turn'))).toEqual([]);
  expect(await events.getHistory(AGENT_CONTROL_TOPIC('turn'))).toEqual([]);
  expect(await memory.getThreadById({ threadId })).not.toBeNull();
  expect(await memory.getObservationalMemory(threadId, resourceId)).toMatchObject({
    activeObservations: 'Private observation',
  });
});

it('retains the independent deletion index across account cascade and restart then erases actual native OM', async () => {
  const { db, host, restart } = await fixture();
  await sensitiveData(host);
  await trackNativeRun(db, descriptor());
  await db.prepare("DELETE FROM users WHERE id='owner'").run();
  expect(
    await db.prepare("SELECT value FROM app_settings WHERE key='native-run:turn'").first(),
  ).not.toBeNull();
  const restored = await restart();
  expect(await restored.cache.get('walden:turn:turn:closures:v1')).toBeDefined();
  expect(await sweepNativeRuns(db, restored)).toMatchObject({ purged: 1, failed: 0 });
  const memory = (await restored.storage.getStore('memory'))!;
  expect(await memory.getThreadById({ threadId })).toBeNull();
  expect(await memory.getObservationalMemory(threadId, resourceId)).toBeNull();
  expect(await restored.cache.get('walden:turn:turn:closures:v1')).toBeUndefined();
  expect(
    await db.prepare("SELECT value FROM app_settings WHERE key='native-run:turn'").first(),
  ).toBeNull();
});

it('defers privacy erasure while the native owner is live then retries after ownership releases', async () => {
  const { db, host } = await fixture();
  const { workflows, memory } = await sensitiveData(host);
  await trackNativeRun(db, descriptor());
  const claim = await workflows.claimRunOwnership({
    runId: 'turn',
    ownerId: 'executor',
    leaseMs: 60000,
  });
  await db.prepare("UPDATE users SET deletion_pending=1 WHERE id='owner'").run();
  expect(await sweepNativeRuns(db, host)).toMatchObject({ deferred: 1, purged: 0 });
  expect(await memory.getThreadById({ threadId })).not.toBeNull();
  await workflows.releaseRunOwnership({
    runId: 'turn',
    ownerId: 'executor',
    generation: claim.record!.generation,
  });
  expect(await sweepNativeRuns(db, host)).toMatchObject({ purged: 1 });
  expect(await memory.getThreadById({ threadId })).toBeNull();
});

it('advances the persisted sweep cursor past 100 healthy runs to reach expired replay', async () => {
  const { db, host } = await fixture();
  await sensitiveData(host);
  for (let index = 0; index < 100; index++) {
    const runId = `active-${String(index).padStart(3, '0')}`;
    await db.prepare("INSERT INTO turns VALUES(?,'conversation','completed')").bind(runId).run();
    await trackNativeRun(db, descriptor(runId));
  }
  await trackNativeRun(db, descriptor());
  await finishNativeRun(db, 'turn', Date.now() - 1);
  expect(await sweepNativeRuns(db, host)).toMatchObject({ scanned: 100, deferred: 100, purged: 0 });
  expect(await host.cache.get('walden:turn:turn:closures:v1')).toBeDefined();
  expect(await sweepNativeRuns(db, host)).toMatchObject({ scanned: 1, purged: 1 });
  expect(await host.cache.get('walden:turn:turn:closures:v1')).toBeUndefined();
});

it.skipIf(process.env.WALDEN_TEST_NATIVE_PURGE_BROKER !== '1')(
  'direct cleanup trims only one run from real Valkey thread streams and clears deleted threads',
  async () => {
    const { host } = await fixture();
    const { memory } = await sensitiveData(host);
    const container = `walden-purge-broker-${randomUUID()}`;
    execFileSync('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-p',
      '127.0.0.1::6379',
      'valkey/valkey:8-alpine',
    ]);
    cleanup.push(() => {
      try {
        execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
      } catch {
        /* Already stopped. */
      }
    });
    let port = '';
    const portDeadline = Date.now() + 5000;
    while (!port && Date.now() < portDeadline) {
      port =
        execFileSync('docker', ['port', container, '6379/tcp'], { encoding: 'utf8' }).match(
          /:(\d+)\s*$/,
        )?.[1] ?? '';
      if (!port) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!port) throw new Error('Disposable Valkey port was not published');
    const url = `redis://127.0.0.1:${port}`;
    const { RedisStreamsPubSub } = await import('@mastra/redis-streams');
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      retryStrategy: (attempt) => (attempt < 10 ? 50 : null),
    });
    redis.on('error', () => {});
    const pubsub = new RedisStreamsPubSub({
      url,
      keyPrefix: 'purge-test',
      streamIdleTtlMs: 3600000,
      redisOptions: { socket: { connectTimeout: 5000, reconnectStrategy: false } },
    });
    cleanup.push(async () => {
      await pubsub.close();
      redis.disconnect();
    });
    await redis.ping();
    host.pubsub = pubsub;
    const topic = `agent.thread-stream.${encodeURIComponent(`${resourceId}\0${threadId}`)}`;
    for (const runId of ['turn', 'another'])
      await pubsub.publish(topic, { type: 'chunk', runId, data: { secret: runId } });
    await purgeNativeRun(host, descriptor(), false);
    const retained = await redis.xrange(`purge-test:${topic}`, '-', '+');
    expect(retained.map(([, fields]) => JSON.parse(fields[1]!).runId)).toEqual(['another']);
    expect(await memory.getObservationalMemory(threadId, resourceId)).not.toBeNull();
    await pubsub.publish(topic, { type: 'chunk', runId: 'turn', data: { secret: 'private' } });
    await purgeNativeRun(host, descriptor(), true);
    expect(await redis.exists(`purge-test:${topic}`)).toBe(0);
    expect(await memory.getThreadById({ threadId })).toBeNull();
    expect(await memory.getObservationalMemory(threadId, resourceId)).toBeNull();
  },
  30000,
);

it('syncs no-expiry policy before sweeping native memory and fails closed when entitlements fail', async () => {
  const { db, host } = await fixture();
  const { memory } = await sensitiveData(host);
  await trackNativeRun(db, descriptor());
  await db.prepare("UPDATE conversations SET expires_at='2000-01-01'").run();
  const env = {
    DB: db,
    APP_POLICY_JSON: JSON.stringify({ retention: { idleDays: null } }),
  } as import('../types').Bindings;
  expect(await sweepNativeRuns(db, host, env)).toMatchObject({ deferred: 1, purged: 0 });
  expect(await memory.getThreadById({ threadId })).not.toBeNull();
  await db.prepare("UPDATE conversations SET expires_at='2000-01-01',retention_disabled=0").run();
  env.ENTITLEMENTS = {
    async getPlan() {
      throw new Error('billing projection unavailable');
    },
  };
  await expect(sweepNativeRuns(db, host, env)).rejects.toMatchObject({ status: 503 });
  expect(await memory.getThreadById({ threadId })).not.toBeNull();
});
