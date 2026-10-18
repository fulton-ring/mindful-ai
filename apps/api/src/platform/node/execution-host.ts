import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { PostgresStore } from '@mastra/pg';
import { type RedisClient, RedisServerCache } from '@mastra/redis';
import { RedisStreamsPubSub } from '@mastra/redis-streams';
import Redis from 'ioredis';
import { Client } from 'pg';
import { registerAgentMemoryStore } from '../../agent/memory/memory';
import type { AppDatabase } from '../../db/database';
import { EXECUTION_RETENTION_MS, type NativeExecutionHost } from '../../execution/native-agent';
import { SqliteCache, type SqliteCacheDriver } from '../../execution/sqlite-cache';
import { openSqliteDatabase } from './sqlite';

/** Pinned SDK cleanup helpers log and swallow transport errors; privacy cleanup must retry. */
export const replayPubSubLogger = {
  warn(...args: unknown[]) {
    if (
      args[0] === 'redis-streams: clearTopic failed' ||
      args[0] === 'redis-streams: trimTopic failed'
    )
      throw new Error('Native replay cleanup failed', { cause: args[1] });
    console.warn(...args);
  },
};

export type NodeExecutionHost = {
  host: NativeExecutionHost;
  close(): Promise<void>;
  ready(): Promise<void>;
};
export type NodeExecutionHostOptions = {
  database: AppDatabase;
  dataDir: string;
  databaseUrl?: string;
  valkeyUrl?: string;
};

function sqliteCacheDriver(database: AppDatabase): SqliteCacheDriver {
  return {
    async execute(sql, args = []) {
      return (
        await database
          .prepare(sql)
          .bind(...args)
          .all()
      ).results;
    },
    async batch(statements) {
      return (
        await database.batch(
          statements.map(({ sql, args = [] }) => database.prepare(sql).bind(...args)),
        )
      ).map((result) => result.results);
    },
  };
}

async function localCache(dataDir: string) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const database = openSqliteDatabase(join(dataDir, 'execution-cache.sqlite'));
  const cache = new SqliteCache({
    driver: sqliteCacheDriver(database),
    ttlMs: EXECUTION_RETENTION_MS,
  });
  try {
    await cache.get('walden:startup');
  } catch (error) {
    database.close();
    throw error;
  }
  const retention = setInterval(() => {
    void cache.prune().catch((error) => console.error('Native cache retention failed', error));
  }, 60 * 60_000);
  retention.unref();
  return {
    cache,
    close() {
      clearInterval(retention);
      database.close();
    },
  };
}

async function storageReady(storage: MastraCompositeStore) {
  const workflows = await storage.getStore('workflows');
  if (!workflows) throw new Error('Native workflow storage is unavailable');
  await workflows.loadWorkflowSnapshot({ workflowName: 'walden-health', runId: 'walden-health' });
}

async function initPostgresStorage(storage: PostgresStore, databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  const lock = ['walden:native-schema:mastra'];
  try {
    await client.connect();
    // Blocking lock statements retain snapshots that can deadlock CREATE INDEX CONCURRENTLY.
    while (
      !(
        await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          lock,
        )
      ).rows[0].locked
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await storage.init();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', lock);
    }
  } finally {
    // Closing the dedicated session also releases its lock if initialization or unlock fails.
    await client.end();
  }
}

async function sqliteHost(dataDir: string): Promise<NodeExecutionHost> {
  const local = await localCache(dataDir);
  const storage = new LibSQLStore({
    id: 'walden-native',
    url: pathToFileURL(join(dataDir, 'mastra.sqlite')).href,
  });
  try {
    await storage.init();
    let closed = false;
    return {
      host: { storage, cache: local.cache },
      async ready() {
        await storageReady(storage);
        await local.cache.get('walden:startup');
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await storage.close();
        } finally {
          local.close();
        }
      },
    };
  } catch (error) {
    await storage.close();
    local.close();
    throw error;
  }
}

async function postgresLocalHost(databaseUrl: string, dataDir: string): Promise<NodeExecutionHost> {
  const local = await localCache(dataDir);
  const storage = new PostgresStore({
    id: 'walden-native',
    connectionString: databaseUrl,
    schemaName: 'mastra',
  });
  try {
    await initPostgresStorage(storage, databaseUrl);
    let closed = false;
    return {
      host: { storage, cache: local.cache },
      async ready() {
        await storageReady(storage);
        await local.cache.get('walden:startup');
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await storage.close();
        } finally {
          local.close();
        }
      },
    };
  } catch (error) {
    await storage.close();
    local.close();
    throw error;
  }
}

async function postgresHost(databaseUrl: string, valkeyUrl: string): Promise<NodeExecutionHost> {
  const storage = new PostgresStore({
    id: 'walden-native',
    connectionString: databaseUrl,
    schemaName: 'mastra',
  });
  const redis = new Redis(valkeyUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: () => null,
  });
  const pubsub = new RedisStreamsPubSub({
    url: valkeyUrl,
    keyPrefix: 'walden:execution',
    logger: replayPubSubLogger,
    streamIdleTtlMs: EXECUTION_RETENTION_MS,
    redisOptions: { socket: { connectTimeout: 5000, reconnectStrategy: false } },
  });
  try {
    await initPostgresStorage(storage, databaseUrl);
    await redis.connect();
    await redis.ping();
    const cache = new RedisServerCache(
      { client: redis as unknown as RedisClient },
      { keyPrefix: 'walden:execution:', ttlSeconds: EXECUTION_RETENTION_MS / 1000 },
    );
    let closed = false;
    return {
      host: { storage, cache, pubsub },
      async ready() {
        await storageReady(storage);
        await redis.ping();
      },
      async close() {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([pubsub.close(), storage.close(), redis.quit()]);
        const failures = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length)
          throw new AggregateError(failures, 'Native execution host shutdown failed');
      },
    };
  } catch (error) {
    await Promise.allSettled([pubsub.close(), storage.close()]);
    redis.disconnect();
    throw error;
  }
}

/** Initialize native workflow/memory schemas explicitly before accepting turns. */
export async function createNodeExecutionHost(
  options: NodeExecutionHostOptions,
): Promise<NodeExecutionHost> {
  if (options.database.dialect === 'postgres' && !options.databaseUrl)
    throw new Error('PostgreSQL native execution requires DATABASE_URL');
  if (options.database.dialect !== 'postgres' && (options.databaseUrl || options.valkeyUrl))
    throw new Error('Native execution configuration does not match the application database');
  const runtime =
    options.database.dialect === 'postgres'
      ? options.valkeyUrl
        ? await postgresHost(options.databaseUrl!, options.valkeyUrl)
        : await postgresLocalHost(options.databaseUrl!, options.dataDir)
      : await sqliteHost(options.dataDir);
  registerAgentMemoryStore(options.database, runtime.host.storage);
  return runtime;
}
