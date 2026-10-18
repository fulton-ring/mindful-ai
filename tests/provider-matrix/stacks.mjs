import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startProvider } from './provider.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const api = join(root, 'apps/api');
const require = createRequire(join(api, 'package.json'));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function healthy(url, diagnostics) {
  let last = '';
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(2_000) }).catch(
      () => null,
    );
    if (response?.ok) return;
    if (response) last = `${response.status}: ${await response.text()}`;
    await delay(100);
  }
  throw new Error(`Stack did not become ready: ${url} ${last}\n${diagnostics()}`);
}

async function startNode(state, port, inference, logs, mixed) {
  const model = resolve(process.env.EMBEDDING_MODEL_DIR ?? join(root, '.cache/models/minilm'));
  await access(join(model, 'onnx/model_quantized.onnx'));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    APP_ROOT: api,
    PUBLIC_DIR: join(root, 'apps/web/dist'),
    DATA_DIR: state,
    EMBEDDING_MODEL_DIR: model,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_URL: `http://127.0.0.1:${port}`,
    AUTH_MODE: 'none',
    MESSAGE_LIMIT: '1000',
    ...inference,
  };
  if (mixed)
    Object.assign(env, {
      FILE_STORAGE: 's3',
      S3_ENDPOINT: process.env.WALDEN_TEST_S3_ENDPOINT,
      S3_PUBLIC_ENDPOINT: process.env.WALDEN_TEST_S3_ENDPOINT,
      S3_BUCKET: process.env.WALDEN_TEST_S3_BUCKET ?? 'walden',
      S3_ACCESS_KEY_ID: process.env.WALDEN_TEST_S3_ACCESS_KEY_ID ?? 'walden-local',
      S3_SECRET_ACCESS_KEY: process.env.WALDEN_TEST_S3_SECRET_ACCESS_KEY ?? 'walden-local-password',
      S3_FORCE_PATH_STYLE: 'true',
      S3_REGION: 'us-east-1',
    });
  const child = spawn(process.execPath, [join(api, 'dist/node/server.js')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => logs.push(String(data)));
  child.stderr.on('data', (data) => logs.push(String(data)));
  return async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function startCloudflare(state, port, inference) {
  const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
  const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
  const bundle = join(api, 'dist/worker.js');
  const modules = [{ type: 'ESModule', path: bundle, contents: await readFile(bundle, 'utf8') }];
  for (const file of await readdir(dirname(bundle)))
    if (file.endsWith('.wasm'))
      modules.push({
        type: 'CompiledWasm',
        path: join(dirname(bundle), file),
        contents: await readFile(join(dirname(bundle), file)),
      });
  const options = convertV4MiniflareOptions({
    name: 'provider-matrix',
    modules,
    modulesRoot: dirname(bundle),
    host: '127.0.0.1',
    port: 0,
    compatibilityDate: '2026-09-18',
    compatibilityFlags: ['nodejs_compat'],
    resourcePersistencePath: state,
    bindings: {
      AUTH_MODE: 'none',
      MESSAGE_LIMIT: '1000',
      UPLOAD_LOCAL_FALLBACK: 'true',
      ...inference,
    },
    d1Databases: { DB: 'provider-matrix' },
    r2Buckets: ['FILES'],
    durableObjects: { CHAT_TURN: { className: 'ChatTurn', useSQLite: true } },
  });
  const mf = new Miniflare(options);
  const initialized = await mf.dispatchFetch('http://provider-matrix/api/config');
  if (!initialized.ok) throw new Error(`Cloudflare initialization failed: ${initialized.status}`);
  await migrateD1(mf);
  const { serve } = require('@hono/node-server');
  const server = serve({
    hostname: '127.0.0.1',
    port,
    fetch: (request) =>
      new URL(request.url).pathname.startsWith('/api/')
        ? dispatch(mf, request)
        : staticAsset(request),
  });
  return async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await mf.dispose();
  };
}

async function dispatch(mf, request) {
  return mf.dispatchFetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
  });
}

async function migrateD1(mf) {
  const db = await mf.getD1Database('DB');
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE name='users'").first();
  if (!exists)
    for (const file of (await readdir(join(api, 'migrations')))
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const source = await readFile(join(api, 'migrations', file), 'utf8');
      for (const sql of source.split('--> statement-breakpoint').filter((s) => s.trim()))
        await db.prepare(sql).run();
    }
}

/** Same-origin static host only; every API request reaches the actual emitted Worker. */
async function staticAsset(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const directory = join(root, 'apps/web/dist');
  let path = resolve(directory, `.${pathname}`);
  if (!path.startsWith(`${directory}/`) && path !== directory)
    return new Response(null, { status: 404 });
  if (!extname(path)) path = join(directory, 'index.html');
  const types = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
  };
  try {
    return new Response(await readFile(path), {
      headers: { 'content-type': types[extname(path)] ?? 'application/octet-stream' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

export async function startStack(name, overrides = {}) {
  const state = await mkdtemp(join(tmpdir(), `walden-matrix-${name}-`));
  const provider = await startProvider();
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const inference = {
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: provider.url,
    AI_API_KEY: 'matrix-fixture-only',
    AI_MODEL: 'fixture-model',
    ...overrides.inference,
  };
  let stop = async () => {};
  const boot = async () => {
    stop =
      name === 'cloudflare'
        ? await startCloudflare(state, port, inference)
        : await startNode(state, port, inference, logs, name === 'mixed');
    await healthy(baseURL, () => logs.join(''));
  };
  const close = async () => {
    await stop();
    await provider.close();
    await rm(state, { recursive: true, force: true });
  };
  try {
    await boot();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    baseURL,
    provider,
    diagnostics: () => logs.join(''),
    close,
    async restart() {
      await stop();
      await boot();
    },
  };
}
