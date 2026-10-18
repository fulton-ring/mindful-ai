import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteDatabase } from './sqlite';

/** Run before serving requests. A write lock serializes competing migration processes. */
export async function applySqliteMigrations(
  db: SqliteDatabase,
  directory: string | URL,
): Promise<void> {
  const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  const migrations = await Promise.all(
    files.map(async (name) => {
      const sql = await readFile(
        directory instanceof URL ? new URL(name, directory) : join(directory, name),
        'utf8',
      );
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
  const { native } = db;
  native.exec('BEGIN IMMEDIATE');
  try {
    native.exec(
      'CREATE TABLE IF NOT EXISTS app_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)',
    );
    const applied = native.prepare('SELECT name,checksum FROM app_migrations').all();
    for (const row of applied) {
      const migration = migrations.find((migration) => migration.name === row.name);
      if (!migration || migration.checksum !== row.checksum)
        throw new Error(`Applied migration changed or missing: ${row.name}`);
    }
    for (const migration of migrations) {
      if (applied.some((row) => row.name === migration.name)) continue;
      native.exec(migration.sql);
      native
        .prepare('INSERT INTO app_migrations(name,checksum,applied_at) VALUES (?,?,?)')
        .run(migration.name, migration.checksum, new Date().toISOString());
    }
    native.exec('COMMIT');
  } catch (error) {
    native.exec('ROLLBACK');
    throw error;
  }
}
