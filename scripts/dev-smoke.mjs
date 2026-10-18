import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'apps/api/src/platform/node/server.ts');

async function sparePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitFor(check, label, milliseconds = 180_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function smokeEnvironment(directory, port, apiPort) {
  const env = {
    ...process.env,
    PORT: String(port),
    WALDEN_API_PORT: String(apiPort),
    APP_URL: `http://localhost:${port}`,
    HOST: '127.0.0.1',
    AUTH_MODE: 'none',
    DATA_DIR: directory,
    SQLITE_PATH: join(directory, 'walden.sqlite'),
    FILES_DIR: join(directory, 'files'),
    DATABASE_URL: '',
    VALKEY_URL: '',
    FILE_STORAGE: 'local',
    APP_ROLE: 'all',
    APP_REPLICAS: '1',
  };
  for (const name of [
    'AI_PROVIDER',
    'AI_MODEL',
    'AI_BACKGROUND_MODEL',
    'AI_MODELS_JSON',
    'AI_API_KEY',
    'AI_BASE_URL',
    'OPENROUTER_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
  ])
    env[name] = '';
  return env;
}

async function exercise(base, log, original) {
  await waitFor(async () => (await fetch(`${base}/health/ready`)).ok, 'standalone readiness');
  assert.match(await (await fetch(base)).text(), /<html/);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.auth.mode, 'none');
  assert.equal(config.modelConfigured, false);
  const response = await fetch(`${base}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ markdown: 'Disposable development smoke note' }),
  });
  assert.equal(response.status, 201);
  const note = await response.json();
  const before = (await readFile(log, 'utf8')).match(/Walden all listening/g)?.length ?? 0;
  const modified = Buffer.concat([
    original,
    Buffer.from('\n/*! Development runner smoke reload. */\n'),
  ]);
  await writeFile(source, modified);
  try {
    await waitFor(
      async () =>
        ((await readFile(log, 'utf8')).match(/Walden all listening/g)?.length ?? 0) > before,
      'API source hot reload',
    );
    await waitFor(async () => (await fetch(`${base}/health/ready`)).ok, 'restarted API readiness');
    const notes = await (await fetch(`${base}/api/notes`)).json();
    assert.equal(notes.find(({ id }) => id === note.id)?.markdown, note.markdown);
  } finally {
    assert.deepEqual(
      await readFile(source),
      modified,
      'Server source changed concurrently; refusing to overwrite it',
    );
    await writeFile(source, original);
  }
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'walden-dev-smoke-'));
  const port = await sparePort();
  let apiPort = await sparePort();
  while (apiPort === port) apiPort = await sparePort();
  const log = join(directory, 'runner.log');
  const descriptor = openSync(log, 'w', 0o600);
  const child = spawn('pnpm', ['dev'], {
    cwd: root,
    env: smokeEnvironment(directory, port, apiPort),
    stdio: ['ignore', descriptor, descriptor],
    detached: true,
  });
  closeSync(descriptor);
  try {
    await exercise(`http://localhost:${port}`, log, await readFile(source));
    console.info(
      'Standalone dev smoke passed: UI/API proxy, no-provider notes, source rebuild and persistence.',
    );
  } catch (error) {
    console.error(await readFile(log, 'utf8'));
    throw error;
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await waitFor(
      async () => {
        const attempts = await Promise.all(
          [port, apiPort].map(async (value) => {
            try {
              await fetch(`http://127.0.0.1:${value}/health/live`);
              return false;
            } catch {
              return true;
            }
          }),
        );
        return attempts.every(Boolean);
      },
      'development process shutdown',
      45_000,
    );
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
