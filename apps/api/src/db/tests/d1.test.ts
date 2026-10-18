import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sqliteD1Binding } from '../../agent/memory/tests/d1-test-binding';
import { createD1Database } from '../d1';
import { DatabaseConstraintError } from '../database';

it('preserves D1 atomic batches and normalizes constraint errors without replacing messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-d1-adapter-'));
  const db = createD1Database(sqliteD1Binding(join(directory, 'app.sqlite')));
  try {
    await db.exec('CREATE TABLE example(id TEXT PRIMARY KEY)');
    await expect(
      db.batch([
        db.prepare("INSERT INTO example VALUES ('a')"),
        db.prepare("INSERT INTO example VALUES ('a')"),
      ]),
    ).rejects.toBeInstanceOf(DatabaseConstraintError);
    expect(await db.prepare('SELECT count(*) AS total FROM example').first()).toEqual({ total: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
