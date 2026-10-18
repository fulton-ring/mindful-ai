import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type NodeRole, readNodeConfig } from './config';
import { dockerTestCommand, dockerTestPort, removeTestContainers } from './docker-test';
import { createNodeRuntime } from './runtime';

const enabled = process.env.WALDEN_TEST_POSTGRES === '1';
const test = enabled ? it : it.skip;
const container = `walden-startup-migrations-${randomUUID()}`;
const runtimes: Awaited<ReturnType<typeof createNodeRuntime>>[] = [];
let root: string;
let pool: Pool;
let databaseUrl: string;
beforeAll(async () => {
  if (!enabled) return;
  root = await mkdtemp(join(tmpdir(), 'walden-startup-pg-'));
  await cp(resolve('postgres-migrations'), join(root, 'postgres-migrations'), { recursive: true });
  await dockerTestCommand([
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=disposable-test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  ]);
  databaseUrl = `postgres://postgres:disposable-test@127.0.0.1:${await dockerTestPort(container, 5432)}/postgres`;
  pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 });
  await vi.waitFor(() => pool.query('SELECT 1'), { timeout: 45000, interval: 100 });
}, 90000);
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close();
  await pool?.end();
  if (root) await rm(root, { recursive: true, force: true });
  if (enabled) await removeTestContainers([container]);
}, 60000);

function config(role: NodeRole) {
  return readNodeConfig({
    APP_ROOT: root,
    DATA_DIR: join(root, randomUUID()),
    APP_ROLE: role,
    DATABASE_URL: databaseUrl,
    VALKEY_URL: 'redis://127.0.0.1:1',
    FILE_STORAGE: 's3',
    S3_BUCKET: 'fixture',
  });
}
async function start(role: NodeRole) {
  const runtime = await createNodeRuntime(config(role), { maintenance: true, environment: {} });
  runtimes.push(runtime);
  return runtime;
}

test('serializes fresh application migrations across concurrently starting Node roles', async () => {
  const results = await Promise.allSettled(
    (['http', 'http', 'worker', 'scheduler', 'migrate'] as const).map(start),
  );
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
  const files = (await readdir(join(root, 'postgres-migrations')))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  expect(
    (await pool.query('SELECT version FROM walden_migrations ORDER BY version')).rows.map(
      (row) => row.version,
    ),
  ).toEqual(files);
  await pool.query(
    "INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES('preserved','subject','now','now')",
  );
  await start('worker');
  expect((await pool.query("SELECT id FROM users WHERE id='preserved'")).rowCount).toBe(1);
});

test('withholds the usable runtime until the migration lock is released and the upgrade commits', async () => {
  await writeFile(
    join(root, 'postgres-migrations', '9000_startup_gate.sql'),
    "CREATE TABLE startup_gate(value TEXT); INSERT INTO startup_gate VALUES('ready');",
  );
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('walden:migrations',0))");
  let available = false;
  const startup = start('http').then((runtime) => {
    available = true;
    return runtime;
  });
  void startup.catch(() => {});
  try {
    await vi.waitFor(async () => {
      const waiting = await pool.query(
        "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
      );
      expect(waiting.rows[0].total).toBeGreaterThan(0);
    });
    expect(available).toBe(false);
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  const runtime = await startup;
  expect(await runtime.db.prepare('SELECT value FROM startup_gate').first('value')).toBe('ready');
  expect((await runtime.fetch(new Request('http://localhost/health/ready'))).status).toBe(200);
});
