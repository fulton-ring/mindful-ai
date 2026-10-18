import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PostgresDatabase } from './postgres';
import { SQLTurnStorage } from './turn-storage';

const enabled = process.env.WALDEN_TEST_POSTGRES === '1';
const test = enabled ? it : it.skip;
const container = `walden-turn-storage-${randomUUID()}`;
const applicationName = `turn-storage-${randomUUID()}`;
let pool: import('pg').Pool;
let db: PostgresDatabase;
const descriptor = (generation: number) => ({
  version: 1 as const,
  startedAt: 1,
  deadlineAt: 9999,
  model: 'fixture',
  generation,
});

beforeAll(async () => {
  if (!enabled) return;
  execFileSync('docker', [
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
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .at(-1);
  const { Pool } = await import('pg');
  pool = new Pool({
    connectionString: `postgres://postgres:disposable-test@127.0.0.1:${port}/postgres`,
    application_name: applicationName,
    max: 6,
  });
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  db = new PostgresDatabase(pool);
  await db.exec(`CREATE TABLE turns(id TEXT PRIMARY KEY, execution_generation INTEGER NOT NULL);
    CREATE TABLE turn_execution_state(turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE, state_json TEXT NOT NULL, alarm_at BIGINT, ended_at BIGINT);
    CREATE TABLE turn_events(turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE, generation INTEGER NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(turn_id,sequence));`);
}, 60000);

afterAll(async () => {
  if (!enabled) return;
  await pool?.end();
  try {
    execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  } catch {
    /* --rm may already have removed it. */
  }
});

async function awaitDatabaseLock(queryPrefix: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2`,
      [applicationName, `${queryPrefix}%`],
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected PostgreSQL row-lock wait for ${queryPrefix}`);
}

async function fixture(turnId: string) {
  await db.prepare('INSERT INTO turns VALUES(?,0)').bind(turnId).run();
  return new SQLTurnStorage(db, turnId);
}

test('runs every SQL turn-storage operation and rejects stale generation mutations on PostgreSQL', async () => {
  const old = await fixture('methods');
  expect(await old.state()).toBeUndefined();
  await old.begin('methods', descriptor(0));
  await old.append(1, { type: 'text-start', id: 'answer' });
  await old.setAlarm(5000);
  await db.prepare('UPDATE turns SET execution_generation=1 WHERE id=?').bind('methods').run();
  const current = new SQLTurnStorage(db, 'methods');
  await current.begin('methods', descriptor(1));
  await current.begin('methods');
  const restarted = new SQLTurnStorage(db, 'methods');
  expect(await restarted.state()).toEqual({ turnId: 'methods', execution: descriptor(1) });
  await expect(old.append(2, { type: 'text-end', id: 'old' })).rejects.toThrow('generation');
  await expect(old.begin('methods', descriptor(0))).rejects.toThrow('generation');
  await old.end(7);
  await old.setAlarm(9);
  await old.clear();
  expect(await restarted.state()).toEqual({ turnId: 'methods', execution: descriptor(1) });
  expect(await restarted.chunks()).toEqual([{ type: 'text-start', id: 'answer' }]);
  await restarted.append(2, { type: 'text-delta', id: 'answer', delta: 'complete' });
  await restarted.end(3000);
  expect(await restarted.state()).toMatchObject({ endedAt: 3000 });
  expect(
    await db
      .prepare('SELECT alarm_at,ended_at FROM turn_execution_state WHERE turn_id=?')
      .bind('methods')
      .first(),
  ).toEqual({ alarm_at: 5000, ended_at: 3000 });
  expect(await restarted.chunks()).toHaveLength(2);
  await restarted.clear();
  expect(await restarted.state()).toBeUndefined();
  expect(await restarted.chunks()).toEqual([]);
  expect(await db.prepare('SELECT id FROM turns WHERE id=?').bind('methods').first()).toEqual({
    id: 'methods',
  });
});

test('rechecks generation after an in-flight claim releases its PostgreSQL row lock', async () => {
  const stale = await fixture('claim-first');
  await stale.begin('claim-first', descriptor(0));
  const claim = await pool.connect();
  let append: Promise<unknown> | undefined;
  try {
    await claim.query('BEGIN');
    await claim.query("UPDATE turns SET execution_generation=1 WHERE id='claim-first'");
    append = stale.append(1, { type: 'text-start', id: 'stale' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await awaitDatabaseLock('INSERT INTO turn_events');
    await claim.query('COMMIT');
    expect(String(await append)).toContain('generation');
    expect(await stale.chunks()).toEqual([]);
    const current = new SQLTurnStorage(db, 'claim-first');
    await current.begin('claim-first', descriptor(1));
    await current.append(1, { type: 'text-start', id: 'current' });
    expect(await current.chunks()).toEqual([{ type: 'text-start', id: 'current' }]);
  } finally {
    await claim.query('ROLLBACK');
    claim.release();
    await append;
  }
});

test('keeps the PostgreSQL owner row locked until an accepted event transaction commits', async () => {
  await fixture('append-first');
  const connection = await pool.connect();
  let claim: Promise<unknown> | undefined;
  try {
    await connection.query('BEGIN');
    const transactionStorage = new SQLTurnStorage(
      new PostgresDatabase(pool, connection),
      'append-first',
    );
    await transactionStorage.begin('append-first', descriptor(0));
    await transactionStorage.append(1, { type: 'text-start', id: 'accepted' });
    claim = pool.query("UPDATE turns SET execution_generation=1 WHERE id='append-first'");
    await awaitDatabaseLock('UPDATE turns SET execution_generation=1');
    await connection.query('COMMIT');
    await claim;
    expect(await transactionStorage.chunks()).toEqual([{ type: 'text-start', id: 'accepted' }]);
    await expect(transactionStorage.append(2, { type: 'text-end', id: 'late' })).rejects.toThrow(
      'generation',
    );
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
    await claim;
  }
});
