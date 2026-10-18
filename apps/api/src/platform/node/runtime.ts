import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { registerAgentMemoryStore } from '../../agent/memory/memory';
import { readAuthMode } from '../../auth';
import { createBetterAuth } from '../../auth/better-auth';
import { createDrizzleAuth } from '../../auth/drizzle';
import { requireAcceptedAuthMode } from '../../auth/state';
import { purgeExpiredConversations } from '../../chat/conversations/deletion';
import { syncRetentionPolicies } from '../../chat/conversations/retention';
import { reconcileTurns } from '../../chat/turns/scheduling';
import type { AppDatabase } from '../../db/database';
import { purgeConversationExecution } from '../../execution/privacy';
import { app } from '../../index';
import { resolveInferenceConfig } from '../../inference/config';
import { validatePolicyConfig } from '../../policy';
import { purgeTelemetry } from '../../privacy/content-telemetry';
import type { Bindings } from '../../types';
import type { NodeConfig } from './config';
import { createNodeExecutionHost } from './execution-host';
import { createPostgresDatabase } from './postgres';
import { migratePostgres } from './postgres-migrations';
import {
  defaultNodeRuntimeAdapters,
  type NodeRuntimeAdapters,
  type NodeRuntimeLifecycle,
  type NodeSavedSources,
} from './runtime-adapters';
import { requireCompatibleSchema } from './schema-version';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite';
import { applySqliteMigrations } from './sqlite-migrations';
import { createNodeTurnRouter } from './turns';

export type NodeRuntimeOptions = {
  migrate?: boolean;
  maintenance?: boolean;
  environment?: NodeJS.ProcessEnv;
  adapters?: NodeRuntimeAdapters;
};
type Closer = () => void | Promise<void>;

async function database(config: NodeConfig, migrate: boolean, closers: Closer[]) {
  let db: AppDatabase;
  let sqlite: SqliteDatabase | undefined;
  let pool: Pool | undefined;
  const directory = join(config.appRoot, config.databaseUrl ? 'postgres-migrations' : 'migrations');
  if (config.databaseUrl) {
    pool = new Pool({ connectionString: config.databaseUrl });
    closers.push(() => pool!.end());
    db = createPostgresDatabase(pool);
    if (migrate) await migratePostgres(pool, directory);
  } else {
    sqlite = openSqliteDatabase(config.sqlitePath);
    closers.push(() => sqlite!.close());
    db = sqlite;
    if (migrate) await applySqliteMigrations(sqlite, directory);
  }
  await requireCompatibleSchema(db, directory);
  return { db, sqlite, pool };
}

function initializeAuth(env: Bindings, sqlite?: SqliteDatabase, pool?: Pool) {
  const mode = readAuthMode(env);
  if (mode === 'better-auth' || (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL)) {
    env.BETTER_AUTH_URL ??= env.APP_URL;
    env.AUTH = sqlite
      ? createBetterAuth(sqlite.native, env)
      : createDrizzleAuth(drizzle(pool!), 'pg', env);
  }
  resolveInferenceConfig(env);
  return mode;
}

async function initializeServices(
  config: NodeConfig,
  env: Bindings,
  closers: Closer[],
  adapters: NodeRuntimeAdapters,
) {
  const healthChecks: Array<() => void | Promise<void>> = [];
  async function manage<T extends NodeRuntimeLifecycle>(
    provider: T,
    ready: () => void | Promise<void> = () => provider.ready?.(),
  ) {
    if (provider.close) closers.push(() => provider.close!());
    healthChecks.push(ready);
    await ready();
    return provider;
  }
  if (adapters.createEntitlementsProvider)
    env.ENTITLEMENTS = await manage(
      await adapters.createEntitlementsProvider(config, { db: env.DB }),
    );
  const files = await (adapters.createObjectStore ?? defaultNodeRuntimeAdapters.createObjectStore)(
    config,
  );
  env.FILES = await manage(files, async () => {
    if (files.ready) await files.ready();
    else await files.list({ prefix: 'health/', limit: 1 });
  });
  env.DOCUMENT_EXTRACTOR = await manage(
    await (adapters.createDocumentExtractor ?? defaultNodeRuntimeAdapters.createDocumentExtractor)(
      config,
    ),
  );
  env.RESEARCH_BROWSER = await manage(
    await (adapters.createResearchBrowser ?? defaultNodeRuntimeAdapters.createResearchBrowser)(
      config,
    ),
  );
  const savedSources = await manage(
    await (adapters.createSavedSources ?? defaultNodeRuntimeAdapters.createSavedSources)(config, {
      db: env.DB,
      blobs: env.FILES,
    }),
  );
  env.SAVED_SOURCES = savedSources;
  const execution = await createNodeExecutionHost({
    database: env.DB,
    dataDir: config.dataDir,
    databaseUrl: config.databaseUrl,
    valkeyUrl: config.valkeyUrl,
  });
  closers.push(execution.close);
  env.EXECUTION = execution.host;
  registerAgentMemoryStore(env.DB, execution.host.storage);
  // Recovery may purge native data using stored expiry; apply current plans first.
  await syncRetentionPolicies(env);
  const turns = createNodeTurnRouter(env, execution.host, {
    execute: config.role === 'all' || config.role === 'worker',
  });
  env.TURNS = turns.router;
  closers.push(() => turns.close());
  await turns.start();
  startSourceIndexing(savedSources, config.role, closers);
  return async () => {
    await execution.ready();
    for (const check of healthChecks) await check();
  };
}

function startSourceIndexing(
  savedSources: NodeSavedSources,
  role: NodeConfig['role'],
  closers: Closer[],
) {
  if (savedSources.resume && (role === 'all' || role === 'worker')) {
    const resumeIndexing = savedSources.resume.bind(savedSources);
    const controller = new AbortController();
    const indexing = new Set<Promise<void>>();
    const resume = () => {
      const task = Promise.resolve().then(() => resumeIndexing(controller.signal));
      indexing.add(task);
      void task
        .catch(() => console.warn('Source indexing deferred'))
        .finally(() => indexing.delete(task));
    };
    closers.push(async () => {
      controller.abort();
      await Promise.allSettled([...indexing]);
    });
    resume();
    const timer = setInterval(resume, 60_000);
    timer.unref();
    closers.push(() => clearInterval(timer));
  }
}

function schedule(
  env: Bindings,
  config: NodeConfig,
  closers: Closer[],
  background: (task: Promise<unknown>) => void,
) {
  if (config.role !== 'all' && config.role !== 'scheduler') return;
  const minute = setInterval(() => background(reconcileTurns(env)), 60_000);
  const hourly = setInterval(
    () =>
      background(
        Promise.all([
          (async () => {
            await syncRetentionPolicies(env);
            await purgeExpiredConversations(env.DB, env.FILES, (owner, id) =>
              purgeConversationExecution(env, owner, id),
            );
          })(),
          purgeTelemetry(env),
        ]),
      ),
    60 * 60_000,
  );
  minute.unref();
  hourly.unref();
  closers.push(() => {
    clearInterval(minute);
    clearInterval(hourly);
  });
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
async function staticResponse(request: Request, root: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405 });
  let path: string;
  try {
    path = resolve(root, `.${decodeURIComponent(new URL(request.url).pathname)}`);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 404 });
  try {
    if (!(await stat(path)).isFile()) path = join(root, 'index.html');
  } catch {
    if (extname(path)) return new Response(null, { status: 404 });
    path = join(root, 'index.html');
  }
  try {
    const bytes = await readFile(path);
    return new Response(request.method === 'HEAD' ? null : bytes, {
      headers: {
        'content-type': mime[extname(path)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      },
    });
  } catch {
    return new Response('Web assets are unavailable.', { status: 503 });
  }
}

function lifecycle(
  closers: Closer[],
  pending: Set<Promise<unknown>>,
  requests: Set<Promise<Response>>,
) {
  let draining = false;
  const background = (task: Promise<unknown>) => {
    pending.add(task);
    void task
      .catch(() => console.warn('Background task deferred'))
      .finally(() => pending.delete(task));
  };
  let closing: Promise<void> | undefined;
  const drain = async () => {
    draining = true;
    await Promise.allSettled([...requests]);
    const failures: unknown[] = [];
    for (const closer of closers.splice(1).reverse()) {
      try {
        await closer();
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.allSettled([...pending]);
    try {
      await closers.pop()?.();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Runtime shutdown failed');
  };
  return {
    background,
    close: () => (closing ??= drain()),
    get draining() {
      return draining;
    },
  };
}

function requestHandler(
  config: NodeConfig,
  env: Bindings,
  state: ReturnType<typeof lifecycle>,
  ready: () => Promise<void>,
) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/health/live') return new Response('ok');
    if (path === '/health/ready') {
      try {
        await ready();
        return new Response('ok');
      } catch {
        return new Response('unavailable', { status: 503 });
      }
    }
    if (state.draining)
      return new Response('Draining', { status: 503, headers: { 'retry-after': '5' } });
    if (config.role !== 'all' && config.role !== 'http') return new Response(null, { status: 404 });
    if (path.startsWith('/api/'))
      return app.fetch(request, env, {
        waitUntil: state.background,
        passThroughOnException() {},
        props: {},
      });
    return staticResponse(request, config.publicDir);
  };
}

/** One composition root; HTTP routes and turn execution are shared with the Worker. */
export async function createNodeRuntime(config: NodeConfig, options: NodeRuntimeOptions = {}) {
  const closers: Closer[] = [];
  const pending = new Set<Promise<unknown>>();
  const requests = new Set<Promise<Response>>();
  const state = lifecycle(closers, pending, requests);
  const { background, close } = state;
  try {
    await mkdir(config.dataDir, { recursive: true });
    const { db, sqlite, pool } = await database(
      config,
      options.migrate ?? config.role === 'all',
      closers,
    );
    const env: Bindings = {
      ...(options.environment ?? process.env),
      DB: db,
      APP_URL: config.appUrl,
    };
    const mode = initializeAuth(env, sqlite, pool);
    validatePolicyConfig(env);
    let executionReady: (() => Promise<void>) | undefined;
    if (!options.maintenance) {
      await requireAcceptedAuthMode(db, mode);
      executionReady = await initializeServices(config, env, closers, options.adapters ?? {});
      schedule(env, config, closers, background);
    }
    const ready = async () => {
      if (state.draining) throw new Error('Draining');
      await db.prepare('SELECT 1').first();
      await executionReady?.();
    };
    const handle = requestHandler(config, env, state, ready);
    const fetch = (request: Request) => {
      const task = handle(request);
      requests.add(task);
      void task.then(
        () => requests.delete(task),
        () => requests.delete(task),
      );
      return task;
    };
    return { env, db, sqlite, ready, fetch, close };
  } catch (error) {
    await close();
    throw error;
  }
}
