import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { registerAgentMemoryStore } from '../../agent/memory/memory';
import { readAuthMode } from '../../auth';
import { createBetterAuth } from '../../auth/better-auth';
import { createDrizzleAuth } from '../../auth/drizzle';
import { requireAcceptedAuthMode } from '../../auth/state';
import { purgeExpiredConversations } from '../../chat/conversations/deletion';
import { reconcileTurns } from '../../chat/turns/scheduling';
import type { AppDatabase } from '../../db/database';
import { purgeConversationExecution } from '../../execution/privacy';
import { app } from '../../index';
import { resolveInferenceConfig } from '../../inference/config';
import { purgeTelemetry } from '../../privacy/content-telemetry';
import { createLocalObjectStore } from '../../storage/local';
import { createS3ObjectStore } from '../../storage/s3';
import type { Bindings } from '../../types';
import type { NodeConfig } from './config';
import { createNodeDocumentExtractor } from './documents/extractor';
import { createNodeExecutionHost } from './execution-host';
import { createPostgresDatabase } from './postgres';
import { migratePostgres } from './postgres-migrations';
import { createPlaywrightResearchBrowser } from './research/browser';
import { createLocalEmbedder } from './research/embeddings';
import { createLocalSavedSources } from './research/saved-sources';
import { requireCompatibleSchema } from './schema-version';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite';
import { applySqliteMigrations } from './sqlite-migrations';
import { createNodeTurnRouter } from './turns';

type RuntimeOptions = { migrate?: boolean; maintenance?: boolean; environment?: NodeJS.ProcessEnv };
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

async function initializeServices(config: NodeConfig, env: Bindings, closers: Closer[]) {
  env.FILES =
    config.fileStorage === 's3'
      ? createS3ObjectStore({
          ...config.s3,
          bucket: config.s3.bucket!,
          credentials: config.s3.accessKeyId
            ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey! }
            : undefined,
        })
      : createLocalObjectStore(config.filesDir);
  await env.FILES.list({ prefix: 'health/', limit: 1 });
  await stat(join(config.appRoot, 'dist/node/document-worker.js'));
  env.DOCUMENT_EXTRACTOR = createNodeDocumentExtractor({
    workerUrl: pathToFileURL(join(config.appRoot, 'dist/node/document-worker.js')),
  });
  env.RESEARCH_BROWSER = createPlaywrightResearchBrowser();
  await Promise.all(
    ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].map((name) =>
      stat(join(config.embeddingModelDir, name)),
    ),
  );
  const savedSources = createLocalSavedSources({
    db: env.DB,
    blobs: env.FILES,
    embedder: createLocalEmbedder({
      modelDirectory: config.embeddingModelDir,
      revision: config.embeddingRevision,
    }),
  });
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
  const turns = createNodeTurnRouter(env, execution.host, {
    execute: config.role === 'all' || config.role === 'worker',
  });
  env.TURNS = turns.router;
  closers.push(() => turns.close());
  await turns.start();
  const controller = new AbortController();
  const indexing = new Set<Promise<void>>();
  const resume = () => {
    const task = savedSources.resume(controller.signal);
    indexing.add(task);
    void task
      .catch(() => console.warn('Source indexing deferred'))
      .finally(() => indexing.delete(task));
  };
  closers.push(async () => {
    controller.abort();
    await Promise.allSettled([...indexing]);
  });
  if (config.role === 'all' || config.role === 'worker') {
    resume();
    const timer = setInterval(resume, 60_000);
    timer.unref();
    closers.push(() => clearInterval(timer));
  }
  return async () => {
    await execution.ready();
    if (config.fileStorage === 's3') await env.FILES!.list({ prefix: 'health/', limit: 1 });
  };
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
          purgeExpiredConversations(env.DB, env.FILES, (owner, id) =>
            purgeConversationExecution(env, owner, id),
          ),
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
export async function createNodeRuntime(config: NodeConfig, options: RuntimeOptions = {}) {
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
    let executionReady: (() => Promise<void>) | undefined;
    if (!options.maintenance) {
      await requireAcceptedAuthMode(db, mode);
      executionReady = await initializeServices(config, env, closers);
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
