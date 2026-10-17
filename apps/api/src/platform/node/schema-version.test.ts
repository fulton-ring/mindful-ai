import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { requireCompatibleSchema } from './schema-version';
import { openSqliteDatabase } from './sqlite';
import { applySqliteMigrations } from './sqlite-migrations';

it('refuses missing, changed, and newer schemas before serving requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'walden-schema-'));
  const db = openSqliteDatabase(join(directory, 'app.sqlite'));
  const migrations = new URL('../../../migrations/', import.meta.url);
  try {
    await expect(requireCompatibleSchema(db, migrations)).rejects.toThrow('migrate');
    await applySqliteMigrations(db, migrations);
    await expect(requireCompatibleSchema(db, migrations)).resolves.toBeUndefined();
    await db
      .prepare("UPDATE app_migrations SET checksum='changed' WHERE name='0000_baseline.sql'")
      .run();
    await expect(requireCompatibleSchema(db, migrations)).rejects.toThrow('migration');
    await applySqliteMigrations(db, migrations).catch(() => {});
    await db.prepare("INSERT INTO app_migrations VALUES('9999_future.sql','new','now')").run();
    await expect(requireCompatibleSchema(db, migrations)).rejects.toThrow('migration');
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
