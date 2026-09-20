import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';
import { conversationRoutes } from './conversations';

type State = {
  ownerId: string;
  noteId: string | null;
  status: string;
  streaming: boolean;
  raceBeforeBatch?: boolean;
  notes: Map<string, { markdown: string; revision: number; provenance: string }>;
  edits: Map<string, { noteId: string; operationId: string }>;
};

function database(state: State) {
  const statement = (sql: string, args: unknown[] = []): D1PreparedStatement =>
    ({
      sql,
      args,
      bind: (...values: unknown[]) => statement(sql, values),
      first: async <T>() => {
        if (sql.includes('JOIN note_edits')) {
          const edit = [...state.edits.values()].find(
            ({ noteId, operationId }) => noteId === state.noteId && operationId === args[2],
          );
          const note = edit ? state.notes.get(edit.noteId) : undefined;
          return (
            note
              ? {
                  id: edit?.noteId,
                  markdown: note.markdown,
                  revision: note.revision,
                  provenance_json: note.provenance,
                  created_at: '2026-09-18T12:00:00.000Z',
                  updated_at: '2026-09-18T12:00:00.000Z',
                }
              : null
          ) as T | null;
        }
        if (sql.includes('FROM conversations'))
          return (
            args[1] === state.ownerId
              ? {
                  id: 'conversation',
                  title: 'Capture test',
                  note_id: state.noteId,
                  expires_at: '2999-01-01T00:00:00.000Z',
                  learning_consent: 0,
                  status: state.status,
                }
              : null
          ) as T | null;
        if (sql.includes("status='streaming'"))
          return (state.streaming ? { id: 'turn' } : null) as T | null;
        return null;
      },
      all: async <T>() => ({
        results: (sql.includes('FROM conversation_branches')
          ? [
              {
                id: 'default',
                head_message_id: null,
                forked_from_message_id: null,
                expires_at: '2999-01-01T00:00:00.000Z',
                status: 'active',
              },
            ]
          : []) as T[],
      }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    }) as unknown as D1PreparedStatement;
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: D1PreparedStatement[]) {
      if (state.raceBeforeBatch) state.streaming = true;
      const eligible =
        state.ownerId === 'owner' &&
        state.status === 'active' &&
        state.noteId === null &&
        !state.streaming;
      if (!eligible)
        return statements.map(() => ({ success: true, meta: { changes: 0 } })) as D1Result[];
      const prepared = statements as unknown as Array<{ sql: string; args: unknown[] }>;
      const noteId = prepared[0]?.args[0] as string;
      const operationId = prepared[1]?.args[1] as string;
      const markdown = prepared[1]?.args[4] as string;
      const provenance = prepared[1]?.args[5] as string;
      state.notes.set(noteId, { markdown, provenance, revision: 1 });
      state.edits.set(operationId, { noteId, operationId });
      state.noteId = noteId;
      return statements.map(() => ({ success: true, meta: { changes: 1 } })) as D1Result[];
    },
  } as unknown as D1Database;
}

function appFor(db: D1Database) {
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

const capture = { text: 'Use the smaller deployment.', verbatim: true, operationId: 'capture-1' };

function sqliteDatabase(
  options: { beforeBatch?: (path: string) => void; failAfter?: number } = {},
) {
  const path = join(mkdtempSync(join(tmpdir(), 'walden-capture-')), 'fixture.sqlite');
  // Read every migration rather than a hand-maintained list: a hardcoded list
  // silently drifts from the real schema each time one is added.
  const migrationsDir = new URL('../../migrations/', import.meta.url);
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
      first: async <T>() => {
        const output = execFileSync('sqlite3', [path, '-json', compile(sql, args)], {
          encoding: 'utf8',
        }).trim();
        return (output ? JSON.parse(output)[0] : null) as T | null;
      },
      all: async <T>() => {
        const output = execFileSync('sqlite3', [path, '-json', compile(sql, args)], {
          encoding: 'utf8',
        }).trim();
        return { results: (output ? JSON.parse(output) : []) as T[] };
      },
      run: async () => {
        const output = execFileSync(
          'sqlite3',
          [path, '-json', `${compile(sql, args)}; SELECT changes() AS changes;`],
          { encoding: 'utf8' },
        ).trim();
        return { success: true, meta: { changes: output ? JSON.parse(output).at(-1).changes : 0 } };
      },
    }) as unknown as D1PreparedStatement;
  const db = {
    prepare: (sql: string) => prepared(sql),
    async batch(statements: D1PreparedStatement[]) {
      options.beforeBatch?.(path);
      const rows = statements as unknown as Array<{ sql: string; args: unknown[] }>;
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
    },
  } as unknown as D1Database;
  const scalar = (sql: string) => execFileSync('sqlite3', [path, sql], { encoding: 'utf8' }).trim();
  return { db, path, scalar };
}

describe('atomic first-note capture', () => {
  it('rejects a conversation owned by another user', async () => {
    const state: State = {
      ownerId: 'someone-else',
      noteId: null,
      status: 'active',
      streaming: false,
      notes: new Map(),
      edits: new Map(),
    };
    expect((await appFor(database(state))(capture)).status).toBe(404);
  });

  it('rejects capture when a note is already attached', async () => {
    const state: State = {
      ownerId: 'owner',
      noteId: 'existing',
      status: 'active',
      streaming: false,
      notes: new Map([['existing', { markdown: 'Existing', revision: 1, provenance: '[]' }]]),
      edits: new Map(),
    };
    expect((await appFor(database(state))(capture)).status).toBe(409);
  });

  it('rejects a streaming race without leaving a note attached', async () => {
    const state: State = {
      ownerId: 'owner',
      noteId: null,
      status: 'active',
      streaming: false,
      raceBeforeBatch: true,
      notes: new Map(),
      edits: new Map(),
    };
    expect((await appFor(database(state))(capture)).status).toBe(409);
    expect(state.noteId).toBeNull();
    expect(state.notes.size).toBe(0);
  });

  it('atomically creates, records, and attaches one note, then replays the operation', async () => {
    const state: State = {
      ownerId: 'owner',
      noteId: null,
      status: 'active',
      streaming: false,
      notes: new Map(),
      edits: new Map(),
    };
    const request = appFor(database(state));

    const created = await request(capture);
    const replayed = await request(capture);

    expect(created.status).toBe(201);
    expect(replayed.status).toBe(200);
    const firstBody = (await created.json()) as { note: { id: string } };
    const replayBody = (await replayed.json()) as { note: { id: string } };
    expect(firstBody.note).toMatchObject({
      markdown: capture.text,
      revision: 1,
      provenance: [
        {
          from: 0,
          to: capture.text.length,
          origin: 'agent',
          verbatim: true,
          captureId: capture.operationId,
        },
      ],
    });
    expect(replayBody.note.id).toBe(firstBody.note.id);
    expect(state.notes.size).toBe(1);
    expect(state.edits.size).toBe(1);
    expect(state.noteId).toBe(firstBody.note.id);
  });

  it('uses SQLite transaction guards to leave no partial note when streaming starts before the batch', async () => {
    const sqlite = sqliteDatabase({
      beforeBatch(path) {
        execFileSync('sqlite3', [path], {
          input:
            "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at) VALUES ('turn','request','conversation','owner','streaming','2026-01-01');",
        });
      },
    });

    const response = await appFor(sqlite.db)(capture);

    expect(response.status).toBe(409);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('0');
    expect(
      sqlite.scalar("SELECT coalesce(note_id,'NULL') FROM conversations WHERE id='conversation';"),
    ).toBe('NULL');
  });

  it('executes the emitted batch SQL transactionally in SQLite and replays its history', async () => {
    const sqlite = sqliteDatabase();
    const request = appFor(sqlite.db);

    const created = await request(capture);
    const replayed = await request(capture);

    expect(created.status).toBe(201);
    expect(replayed.status).toBe(200);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('1');
    expect(sqlite.scalar("SELECT base_revision||':'||result_revision FROM note_edits;")).toBe(
      '0:1',
    );
    expect(
      sqlite.scalar(
        "SELECT n.markdown||':'||n.revision FROM notes n JOIN conversations c ON c.note_id=n.id WHERE c.id='conversation';",
      ),
    ).toBe(`${capture.text}:1`);
  });

  it('rolls back the emitted SQLite transaction when a batch statement fails', async () => {
    const sqlite = sqliteDatabase({ failAfter: 1 });

    const response = await appFor(sqlite.db)(capture);

    expect(response.status).toBe(500);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('0');
    expect(sqlite.scalar('SELECT count(*) FROM note_edits;')).toBe('0');
    expect(
      sqlite.scalar("SELECT coalesce(note_id,'NULL') FROM conversations WHERE id='conversation';"),
    ).toBe('NULL');
  });
});
