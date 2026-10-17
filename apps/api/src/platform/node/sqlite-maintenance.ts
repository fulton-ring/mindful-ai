import { createReadStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';

/** Restore a standalone SQLite snapshot while the application is stopped. Never overwrite data. */
export async function restoreSqliteBackup(source: string, destination: string): Promise<void> {
  const check = new DatabaseSync(source, { readOnly: true });
  try {
    const rows = check.prepare('PRAGMA integrity_check').all();
    if (
      rows.length !== 1 ||
      rows[0].integrity_check !== 'ok' ||
      check.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('Invalid SQLite backup: integrity check failed');
  } finally {
    check.close();
  }
  await mkdir(dirname(destination), { recursive: true });
  const target = await open(destination, 'wx', 0o600);
  try {
    await pipeline(createReadStream(source), target.createWriteStream());
  } catch (error) {
    await target.close();
    await rm(destination, { force: true });
    throw error;
  }
}
