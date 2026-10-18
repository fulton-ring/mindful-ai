import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { applyD1Migrations, D1_MIGRATIONS_TABLE_SQL } from '../d1-migrations';
import type { AppDatabase, AppStatement } from '../database';

const directory = new URL('../../../migrations/', import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, directory), 'utf8') }));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
const database = async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      d1Databases: { DB: 'test' },
      compatibilityDate: '2026-09-18',
    }),
  );
  cleanup.push(() => mf.dispose());
  return (await mf.getD1Database('DB')) as AppDatabase;
};
it('initializes an empty database and records Wrangler-compatible names and immutable checksums', async () => {
  const db = await database();
  await applyD1Migrations(db, migrations);
  expect(
    await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='users'").first(),
  ).toEqual({ n: 1 });
  expect(
    (await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(
      (row) => row.name,
    ),
  ).toEqual(migrations.map((row) => row.name));
  expect((await db.prepare('SELECT checksum FROM app_migrations').all()).results).toHaveLength(
    migrations.length,
  );
  const ledger = (await db.prepare('SELECT * FROM app_migrations ORDER BY name').all()).results;
  await applyD1Migrations(db, migrations);
  expect((await db.prepare('SELECT * FROM app_migrations ORDER BY name').all()).results).toEqual(
    ledger,
  );
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
it('adopts a legacy Wrangler baseline without replaying it or replacing existing data', async () => {
  const db = await database();
  await db.batch(
    migrations[0].sql
      .split('--> statement-breakpoint')
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql)),
  );
  await db.batch([
    db.prepare(D1_MIGRATIONS_TABLE_SQL),
    db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES('0000_baseline.sql','legacy')"),
    db.prepare("INSERT INTO users VALUES('owner','clerk-subject','now','now',0)"),
  ]);
  await applyD1Migrations(db, migrations);
  expect(await db.prepare('SELECT id,auth_provider,auth_subject FROM users').first()).toEqual({
    id: 'owner',
    auth_provider: 'clerk',
    auth_subject: 'clerk-subject',
  });
  expect(
    await db.prepare("SELECT applied_at FROM d1_migrations WHERE name='0000_baseline.sql'").first(),
  ).toEqual({ applied_at: 'legacy' });
  expect(await db.prepare('SELECT count(*) AS n FROM app_migrations').first()).toEqual({
    n: migrations.length,
  });
});
it('rolls back every pending DDL statement and both ledger writes when a later statement fails', async () => {
  const db = await database();
  await expect(
    applyD1Migrations(db, [
      ...migrations,
      {
        name: '0003_broken.sql',
        sql: 'CREATE TABLE partial(id TEXT);\n--> statement-breakpoint\nINVALID SQL',
      },
    ]),
  ).rejects.toThrow();
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('users','partial')")
      .first(),
  ).toEqual({ n: 0 });
  expect(await db.prepare('SELECT count(*) AS n FROM d1_migrations').first()).toEqual({ n: 0 });
});
it('rejects modified applied migration SQL before executing any new DDL', async () => {
  const db = await database();
  await applyD1Migrations(db, migrations);
  await expect(
    applyD1Migrations(
      db,
      migrations.map((row, index) =>
        index === 0 ? { ...row, sql: row.sql + '\n-- changed' } : row,
      ),
    ),
  ).rejects.toThrow(/changed|checksum/);
  await db
    .prepare("UPDATE app_migrations SET checksum='' WHERE name=?")
    .bind(migrations[0].name)
    .run();
  await expect(applyD1Migrations(db, migrations)).rejects.toThrow(/checksum/);
});

it('serializes twelve stale startup snapshots with unique name fences before any DDL', async () => {
  const db = await database();
  const queries = new WeakMap<AppStatement, string>();
  let snapshots = 0,
    conflicts = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const racing: AppDatabase = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      queries.set(statement, sql);
      return statement;
    },
    async batch<T>(batch: AppStatement[]) {
      try {
        const result = await db.batch<T>(batch);
        if (queries.get(batch[0]) === 'SELECT name FROM d1_migrations' && snapshots < 12) {
          snapshots++;
          if (snapshots === 12) release();
          await barrier;
        }
        return result;
      } catch (error) {
        conflicts++;
        throw error;
      }
    },
  };
  await Promise.all(Array.from({ length: 12 }, () => applyD1Migrations(racing, migrations)));
  expect(conflicts).toBeGreaterThan(0);
  expect(await db.prepare('SELECT count(*) AS n FROM d1_migrations').first()).toEqual({
    n: migrations.length,
  });
  expect(await db.prepare('SELECT count(*) AS n FROM app_migrations').first()).toEqual({
    n: migrations.length,
  });
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});

it('registers every canonical SQL migration in the Worker Text manifest', () => {
  const source = readFileSync(new URL('../d1-startup.ts', import.meta.url), 'utf8');
  const registered = [...source.matchAll(/name:\s*'([^']+\.sql)'/g)].map((match) => match[1]);
  expect(registered).toEqual(migrations.map((row) => row.name));
});
