import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteDatabase } from '../../platform/node/sqlite';
import { applySqliteMigrations } from '../../platform/node/sqlite-migrations';
import { prepareQuery } from '../database';

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-sqlite-'));
  directories.push(directory);
  return { directory, db: openSqliteDatabase(join(directory, 'app.sqlite')) };
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('binds parameters without interpolation and returns D1-compatible result metadata', async () => {
  const { db } = fixture();
  try {
    await db.exec('CREATE TABLE example(id TEXT PRIMARY KEY, value TEXT)');
    const value = "? ' ; DROP TABLE example; --";
    expect(
      (await db.prepare('INSERT INTO example VALUES (?,?)').bind('a', value).run()).meta.changes,
    ).toBe(1);
    expect(await db.prepare('SELECT value FROM example WHERE id=?').bind('a').first('value')).toBe(
      value,
    );
    expect(
      (await db.prepare('SELECT * FROM example WHERE id=?1 OR id=?1').bind('a').all()).results,
    ).toEqual([{ id: 'a', value }]);
    expect(
      await prepareQuery(db, { sqlite: 'SELECT 1 AS value', postgres: 'invalid' }).first(),
    ).toEqual({ value: 1 });
    await expect(db.prepare('SELECT ?').bind(undefined).all()).rejects.toThrow();
  } finally {
    db.close();
  }
});

it('rolls the whole batch back after a constraint failure and returns rows for successful batches', async () => {
  const { db } = fixture();
  try {
    await db.exec('CREATE TABLE example(id TEXT PRIMARY KEY)');
    await expect(
      db.batch([
        db.prepare("INSERT INTO example VALUES ('a')"),
        db.prepare("INSERT INTO example VALUES ('a')"),
      ]),
    ).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) AS total FROM example').first('total')).toBe(0);
    expect(
      (
        await db.batch([
          db.prepare("INSERT INTO example VALUES ('b')"),
          db.prepare('SELECT id FROM example'),
        ])
      )[1].results,
    ).toEqual([{ id: 'b' }]);
  } finally {
    db.close();
  }
});

it('migrates existing data once, rejects changed migrations, and restores an integrity-checked backup', async () => {
  const { db, directory } = fixture();
  try {
    writeFileSync(
      join(directory, '0000.sql'),
      "CREATE TABLE example(id TEXT PRIMARY KEY); INSERT INTO example VALUES ('preserved');",
    );
    await applySqliteMigrations(db, directory);
    await applySqliteMigrations(db, directory);
    await db.backup(join(directory, 'backup.sqlite'));
    const restored = openSqliteDatabase(join(directory, 'backup.sqlite'));
    try {
      await restored.integrityCheck();
      expect(await restored.prepare('SELECT id FROM example').first('id')).toBe('preserved');
    } finally {
      restored.close();
    }
    writeFileSync(join(directory, '0000.sql'), 'CREATE TABLE changed(id TEXT);');
    await expect(applySqliteMigrations(db, directory)).rejects.toThrow(/changed/);
  } finally {
    db.close();
  }
});

it('does not mark a failing migration applied or leave its partial schema behind', async () => {
  const { db, directory } = fixture();
  try {
    writeFileSync(
      join(directory, '0000.sql'),
      'CREATE TABLE partial(id TEXT); INSERT INTO missing VALUES (1);',
    );
    await expect(applySqliteMigrations(db, directory)).rejects.toThrow();
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").first(),
    ).toBeNull();
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name='app_migrations'").first(),
    ).toBeNull();
  } finally {
    db.close();
  }
});

it('keeps parameters inside SQL literals and comments literal and supports mixed parameter slots', async () => {
  const { db } = fixture();
  try {
    expect(
      await db.prepare("SELECT '?9' AS literal,?1 AS a,? AS b -- ?8").bind('one', 'two').first(),
    ).toEqual({ literal: '?9', a: 'one', b: 'two' });
    await db.exec('CREATE TABLE example(id TEXT PRIMARY KEY)');
    expect(
      (await db.prepare("INSERT INTO example VALUES ('a') RETURNING id").run()).meta.changes,
    ).toBe(1);
    expect((await db.prepare('SELECT id FROM example').all()).meta.changes).toBe(0);
  } finally {
    db.close();
  }
});

it('normalizes constraint errors while preserving the database message', async () => {
  const { db } = fixture();
  try {
    await db.exec('CREATE TABLE example(id TEXT PRIMARY KEY)');
    await db.prepare("INSERT INTO example VALUES ('a')").run();
    await expect(db.prepare("INSERT INTO example VALUES ('a')").run()).rejects.toMatchObject({
      name: 'DatabaseConstraintError',
      code: 'constraint',
      message: expect.stringContaining('UNIQUE constraint failed'),
    });
  } finally {
    db.close();
  }
});
