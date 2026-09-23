import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { conversationRoutes } from '../../conversations/conversations';

type Prepared = { sql: string; args: unknown[] };

export function appFor(db: D1Database) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api', conversationRoutes);
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ error: error.message }, error.status) : c.json({}, 500),
  );
  return (body: unknown) =>
    app.fetch(
      new Request('https://walden.test/api/conversations/conversation/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { DB: db } as Bindings,
    );
}

export const capture = {
  text: 'Use the smaller deployment.',
  verbatim: true,
  operationId: 'capture-1',
};

type SqliteOptions = { beforeBatch?: (path: string) => void; failAfter?: number };

function createSqliteDatabase(path: string, options: SqliteOptions) {
  const migrationsDir = new URL('../../../../migrations/', import.meta.url);
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(new URL(name, migrationsDir), 'utf8'))
    .join('\n');
  execFileSync('sqlite3', [path], {
    input: `${migrations}
      INSERT INTO users (id,auth_subject,created_at,updated_at) VALUES ('owner','subject','2026-01-01','2026-01-01');
      INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at)
      VALUES ('conversation','owner',NULL,'Capture test','2026-01-01','2999-01-01','active','2026-01-01');
      INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,last_user_activity_at,expires_at,created_at)
      VALUES ('default','conversation','owner',1,'2026-01-01','2999-01-01','2026-01-01');`,
  });
  return sqliteD1(path, options);
}

function sqliteD1(path: string, options: SqliteOptions) {
  const literal = (value: unknown) =>
    value === null
      ? 'NULL'
      : typeof value === 'number'
        ? String(value)
        : `'${String(value).replaceAll("'", "''")}'`;
  const compile = (sql: string, args: unknown[]) => {
    let index = 0;
    return sql.replaceAll('?', () => literal(args[index++]));
  };
  const prepared = (sql: string, args: unknown[] = []): D1PreparedStatement =>
    ({
      sql,
      args,
      bind: (...values: unknown[]) => prepared(sql, values),
      first: async <T>() => sqliteFirst<T>(path, sql, args, compile),
      all: async <T>() => sqliteAll<T>(path, sql, args, compile),
      run: async () => sqliteRun(path, sql, args, compile),
    }) as unknown as D1PreparedStatement;
  const db = {
    prepare: (sql: string) => prepared(sql),
    batch: (statements: D1PreparedStatement[]) => sqliteBatch(path, options, statements, compile),
  } as unknown as D1Database;
  const scalar = (sql: string) => execFileSync('sqlite3', [path, sql], { encoding: 'utf8' }).trim();
  return { db, scalar };
}

function sqliteFirst<T>(
  path: string,
  sql: string,
  args: unknown[],
  compile: (sql: string, args: unknown[]) => string,
) {
  const output = execFileSync('sqlite3', [path, '-json', compile(sql, args)], {
    encoding: 'utf8',
  }).trim();
  return (output ? JSON.parse(output)[0] : null) as T | null;
}

function sqliteAll<T>(
  path: string,
  sql: string,
  args: unknown[],
  compile: (sql: string, args: unknown[]) => string,
) {
  const output = execFileSync('sqlite3', [path, '-json', compile(sql, args)], {
    encoding: 'utf8',
  }).trim();
  return { results: (output ? JSON.parse(output) : []) as T[] };
}

function sqliteRun(
  path: string,
  sql: string,
  args: unknown[],
  compile: (sql: string, args: unknown[]) => string,
) {
  const output = execFileSync(
    'sqlite3',
    [path, '-json', `${compile(sql, args)}; SELECT changes() AS changes;`],
    { encoding: 'utf8' },
  ).trim();
  return { success: true, meta: { changes: output ? JSON.parse(output).at(-1).changes : 0 } };
}

function sqliteBatch(
  path: string,
  options: SqliteOptions,
  statements: D1PreparedStatement[],
  compile: (sql: string, args: unknown[]) => string,
) {
  options.beforeBatch?.(path);
  const rows = statements as unknown as Prepared[];
  const script = [
    'BEGIN IMMEDIATE;',
    'CREATE TEMP TABLE capture_changes(value INTEGER);',
    ...rows.flatMap((row, index) => [
      `${compile(row.sql, row.args)};`,
      'INSERT INTO capture_changes VALUES (changes());',
      ...(options.failAfter === index ? ['INSERT INTO missing_capture_table VALUES (1);'] : []),
    ]),
    'COMMIT;',
    'SELECT value AS changes FROM capture_changes ORDER BY rowid;',
  ].join('\n');
  const output = execFileSync('sqlite3', [path, '-json', script], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const changes = output ? (JSON.parse(output) as Array<{ changes: number }>) : [];
  return changes.map(({ changes }) => ({ success: true, meta: { changes } })) as D1Result[];
}

export function sqliteDatabase(options: SqliteOptions = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'walden-capture-')), 'fixture.sqlite');
  return createSqliteDatabase(path, options);
}
