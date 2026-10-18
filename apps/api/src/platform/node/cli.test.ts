import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Bindings } from '../../types';
import { runMaintenanceCommand } from './cli';
import { openSqliteDatabase } from './sqlite';
import { restoreSqliteBackup } from './sqlite-maintenance';
import { applySqliteMigrations } from './sqlite-migrations';

it('exports private snapshots, refuses overwrites, and restores an integrity-checked physical backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-cli-'));
  const db = openSqliteDatabase(join(directory, 'app.sqlite'));
  const runtime = { db, sqlite: db, env: { DB: db } as Bindings, close: () => db.close() };
  try {
    await applySqliteMigrations(db, new URL('../../../migrations/', import.meta.url));
    await db
      .prepare(
        "INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES ('owner','subject','now','now')",
      )
      .run();
    const json = join(directory, 'private.json');
    await runMaintenanceCommand(runtime, ['export', json]);
    expect(JSON.parse(readFileSync(json, 'utf8')).format).toBe('walden-application-snapshot');
    expect(statSync(json).mode & 0o777).toBe(0o600);
    await expect(runMaintenanceCommand(runtime, ['export', json])).rejects.toThrow();
    const backup = join(directory, 'backup.sqlite');
    await runMaintenanceCommand(runtime, ['backup', backup]);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    await expect(runMaintenanceCommand(runtime, ['backup', backup])).rejects.toThrow();
    const destination = join(directory, 'restored.sqlite');
    await restoreSqliteBackup(backup, destination);
    const restored = openSqliteDatabase(destination);
    try {
      expect(await restored.prepare('SELECT id FROM users').first()).toEqual({ id: 'owner' });
      await restored.integrityCheck();
    } finally {
      restored.close();
    }
    await expect(restoreSqliteBackup(backup, destination)).rejects.toThrow();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
