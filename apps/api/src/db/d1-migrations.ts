import type { AppDatabase, AppStatement } from './database';

export type SqlMigration = { name: string; sql: string };
type Migration = SqlMigration & { checksum: string };
type Applied = { names: Set<string>; checksums: Map<string, string>; applied: Set<string> };

/** Identical to Wrangler's default ledger, so its migration commands keep working. */
export const D1_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;
const CHECKSUMS_SQL = `CREATE TABLE IF NOT EXISTS app_migrations(
  name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)`;

async function readApplied(db: AppDatabase, migrations: readonly Migration[]): Promise<Applied> {
  const [names, sums] = await db.batch<{ name: string; checksum: string }>([
    db.prepare('SELECT name FROM d1_migrations'),
    db.prepare('SELECT name,checksum FROM app_migrations'),
  ]);
  const state: Applied = {
    names: new Set(names.results.map((row) => row.name)),
    checksums: new Map(sums.results.map((row) => [row.name, row.checksum])),
    applied: new Set([...names.results, ...sums.results].map((row) => row.name)),
  };
  for (const name of state.applied) {
    const migration = migrations.find((item) => item.name === name);
    if (!migration) throw new Error(`Applied migration missing from Worker: ${name}`);
    const checksum = state.checksums.get(name);
    if (checksum !== undefined && checksum !== migration.checksum)
      throw new Error(`Applied migration checksum changed: ${name}`);
  }
  let pending = false;
  for (const migration of migrations) {
    if (!state.applied.has(migration.name)) pending = true;
    else if (pending)
      throw new Error(`Migration ledger is not a contiguous prefix: ${migration.name}`);
  }
  return state;
}

function statements(
  db: AppDatabase,
  migrations: readonly Migration[],
  state: Applied,
): AppStatement[] {
  return migrations.flatMap((migration) => {
    const result: AppStatement[] = [];
    if (!state.names.has(migration.name)) {
      // The unique name is acquired BEFORE DDL, in the same atomic D1 batch.
      result.push(db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(migration.name));
    }
    if (!state.applied.has(migration.name)) {
      result.push(
        ...migration.sql
          .split('--> statement-breakpoint')
          .map((sql) => sql.trim())
          .filter(Boolean)
          .map((sql) => db.prepare(sql)),
      );
    }
    if (!state.checksums.has(migration.name)) {
      result.push(
        db
          .prepare(
            'INSERT INTO app_migrations(name,checksum,applied_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING',
          )
          .bind(migration.name, migration.checksum, new Date().toISOString()),
      );
    }
    return result;
  });
}

/** D1 batch transactions serialize unique ledger inserts and roll back DDL and ledger together.
 * https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 * Legacy Wrangler entries are trusted once, then gain immutable canonical checksums.
 */
export async function applyD1Migrations(
  db: AppDatabase,
  input: readonly SqlMigration[],
): Promise<void> {
  const migrations = await Promise.all(
    input.map(async (migration) => ({
      ...migration,
      checksum: Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(migration.sql)),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    })),
  );
  if (
    new Set(migrations.map((row) => row.name)).size !== migrations.length ||
    migrations.some((row, index) => index > 0 && row.name <= migrations[index - 1].name)
  )
    throw new Error('Migrations must have unique ordered names');
  await db.batch([db.prepare(D1_MIGRATIONS_TABLE_SQL), db.prepare(CHECKSUMS_SQL)]);
  let state = await readApplied(db, migrations);
  for (let attempt = 0; attempt <= migrations.length; attempt++) {
    const pending = statements(db, migrations, state);
    if (!pending.length) return;
    try {
      await db.batch(pending);
    } catch (error) {
      const winner = await readApplied(db, migrations);
      // A losing unique fence is safe only when another startup actually made progress.
      if (
        winner.applied.size <= state.applied.size &&
        winner.checksums.size <= state.checksums.size &&
        winner.names.size <= state.names.size
      )
        throw error;
      state = winner;
      continue;
    }
    state = await readApplied(db, migrations);
  }
  throw new Error('Database startup migration contention did not settle');
}
