import { randomUUID } from 'node:crypto';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAccount, resetAccountPassword } from '../../auth/admin';
import { createDrizzleAuth } from '../../auth/drizzle';
import { conversationRoutes } from '../../chat/conversations/conversations';
import { loadConversation } from '../../chat/conversations/repository';
import { agentHighlightStatements } from '../../chat/highlights/agent-highlights';
import { highlightRoutes } from '../../chat/highlights/highlights';
import { chargeMessage, refundMessage } from '../../chat/turns/message-limit';
import { prepareTurn } from '../../chat/turns/turn-lifecycle';
import * as turns from '../../chat/turns/turn-store';
import type { AppDatabase } from '../../db/database';
import { exportApplicationSnapshot, importApplicationSnapshot } from '../../db/transfer';
import { metricsRoutes } from '../../metrics/routes';
import { moveNoteHistory } from '../../notes/history/history-actions';
import { saveNote } from '../../notes/save-note';
import { cancelNoteSuggestionAttempt } from '../../notes/suggestions/cancellation';
import { persistNoteSuggestion } from '../../notes/suggestions/suggestions';
import { personaRoutes } from '../../personas/routes';
import type { Bindings, Variables } from '../../types';
import { dockerTestCommand, dockerTestPort, removeTestContainers } from './docker-test';
import { createPostgresDatabase } from './postgres';
import { migratePostgres } from './postgres-migrations';
import { openSqliteDatabase } from './sqlite';
import { applySqliteMigrations } from './sqlite-migrations';

const enabled = process.env.WALDEN_TEST_POSTGRES === '1';
const test = enabled ? it : it.skip;
const container = `walden-pg-test-${randomUUID()}`;
let pool: import('pg').Pool;
let db: AppDatabase;
beforeAll(async () => {
  if (!enabled) return;
  await dockerTestCommand([
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=disposable-test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  ]);
  const port = await dockerTestPort(container, 5432);
  const { Pool } = await import('pg');
  pool = new Pool({
    connectionString: `postgres://postgres:disposable-test@127.0.0.1:${port}/postgres`,
    max: 12,
    connectionTimeoutMillis: 1000,
  });
  const deadline = Date.now() + 45000;
  while (true) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const migration = await import('./postgres-migrations').catch(() => null);
  expect(migration?.migratePostgres).toBeTypeOf('function');
  await migration!.migratePostgres(pool);
  await migration!.migratePostgres(pool);
  db = createPostgresDatabase(pool);
  await db
    .prepare(
      "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('owner','subject','now','now',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversations(id,owner_id,last_user_activity_at,expires_at,created_at) VALUES('chat','owner','now','2999','now')",
    )
    .run();
  for (const id of ['a', 'b', 'c'])
    await db
      .prepare(
        "INSERT INTO conversation_branches(id,conversation_id,owner_id,created_at) VALUES(?,'chat','owner','now')",
      )
      .bind(id)
      .run();
}, 90000);
afterAll(async () => {
  await pool?.end();
  if (enabled) await removeTestContainers([container]);
}, 60000);
test('normalizes results, binds repeats and atomically rolls back batches', async () => {
  expect(
    await db.prepare('SELECT ?2 AS second,?1 AS first,?2 AS again').bind('a', 'b').first(),
  ).toEqual({ second: 'b', first: 'a', again: 'b' });
  expect(await db.prepare('SELECT COUNT(*) AS count FROM users').first()).toEqual({ count: 1 });
  await expect(
    db.batch([
      db.prepare(
        "INSERT INTO notes(id,owner_id,created_at,updated_at) VALUES('rollback','owner','now','now')",
      ),
      db.prepare(
        "INSERT INTO notes(id,owner_id,created_at,updated_at) VALUES('rollback','owner','now','now')",
      ),
    ]),
  ).rejects.toThrow();
  expect(await db.prepare("SELECT id FROM notes WHERE id='rollback'").first()).toBeNull();
});
test('enforces concurrent weighted budget and refunds without going below zero', async () => {
  const charges = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      chargeMessage(db as never, 'owner', { limit: 4, windowHours: 4 }, 1),
    ),
  );
  expect(charges.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
  const window = await db
    .prepare("SELECT started_at,used FROM message_windows WHERE owner_id='owner'")
    .first<{ started_at: string; used: number }>();
  expect(window?.used).toBe(4);
  await refundMessage(db as never, 'owner', window!.started_at, 10);
  expect(
    await db.prepare("SELECT used FROM message_windows WHERE owner_id='owner'").first(),
  ).toEqual({ used: 0 });
});
test('serializes source and target overlap and rejects cancellation before admission', async () => {
  const insert = (id: string, target: string, source: string) =>
    db
      .prepare(
        "INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES(?,?,'chat','owner','streaming','now',?,?)",
      )
      .bind(id, id, target, source)
      .run();
  const attempts = await Promise.allSettled([
    insert('turn-a', 'a', 'a'),
    insert('turn-b', 'b', 'a'),
    insert('turn-c', 'c', 'b'),
  ]);
  const active = (
    await db
      .prepare("SELECT branch_id,source_branch_id FROM turns WHERE status='streaming'")
      .all<{ branch_id: string; source_branch_id: string }>()
  ).results;
  expect(attempts.some((r) => r.status === 'rejected')).toBe(true);
  const ids = active.flatMap((row) => [...new Set([row.branch_id, row.source_branch_id])]);
  expect(new Set(ids).size).toBe(ids.length);
  await db.prepare("INSERT INTO turn_cancellations VALUES('owner','cancelled','now')").run();
  await expect(insert('cancelled', 'c', 'c')).rejects.toThrow(/cancelled before admission/);
});
test('fences stale execution generations and refuses a cancelled execution claim', async () => {
  expect(turns.claimTurnExecution).toBeTypeOf('function');
  await db.prepare("UPDATE turns SET status='completed'").run();
  const created = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES('fenced','fenced','chat','owner','streaming',?,'a','a')",
    )
    .bind(created)
    .run();
  const first = await turns.claimTurnExecution(db as never, 'fenced');
  const second = await turns.claimTurnExecution(db as never, 'fenced');
  expect(first?.execution_generation).toBe(1);
  expect(second?.execution_generation).toBe(2);
  expect(await turns.isTurnActive(db as never, 'fenced', 1)).toBe(false);
  expect(await turns.completeTurn(db as never, first!, [])).toBeNull();
  expect(await db.prepare("SELECT id FROM messages WHERE id='fenced'").first()).toBeNull();
  await turns.recordTurnCancellation(db as never, second!);
  expect(await turns.claimTurnExecution(db as never, 'fenced')).toBeNull();
});

test('charges the configured provider model weight during admission', async () => {
  await db.prepare("UPDATE turns SET status='completed'").run();
  await db.prepare('DELETE FROM message_windows').run();
  const result = await prepareTurn(
    {
      db,
      ownerId: 'owner',
      messageLimit: { limit: 4, windowHours: 4 },
      modelFor: () => 'hosted/custom',
      modelWeightFor: () => 3,
    },
    {
      requestId: 'weighted-request',
      conversationId: 'chat',
      branchId: 'a',
      noteRevision: null,
      message: 'Weighted question',
      personaId: 'thinking-partner',
      action: 'message',
    },
  );
  expect(result.kind === 'stream' && result.turn.weight).toBe(3);
  expect(
    await db.prepare("SELECT used FROM message_windows WHERE owner_id='owner'").first(),
  ).toEqual({ used: 3 });
  await db.prepare("UPDATE turns SET status='completed'").run();
  await db.prepare('DELETE FROM messages').run();
  await db.prepare('UPDATE conversation_branches SET head_message_id=NULL').run();
});

test('runs real admission, completion, JSON transcript/search/metrics and note suggestion queries', async () => {
  const row = await seedCompletedConversation();
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api/chat', conversationRoutes);
  app.route('/api/chat', highlightRoutes);
  app.route('/api/metrics', metricsRoutes);
  const env = { DB: db } as unknown as Bindings;
  expect((await app.request('/api/chat/conversations?q=octopus', {}, env)).status).toBe(200);
  expect(
    await (await app.request('/api/chat/conversations?q=octopus', {}, env)).json(),
  ).toHaveLength(1);
  expect((await app.request('/api/metrics/usage', {}, env)).status).toBe(200);
  expect(
    (
      await app.request(
        `/api/chat/messages/${row.id}/highlights`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ start: 3, end: 10, quote: 'octopus', color: 'yellow' }),
        },
        env,
      )
    ).status,
  ).toBe(200);
  const highlighted = await loadConversation(db, 'owner', 'chat', { branchId: 'a' });
  expect(highlighted.messages[1]?.metadata?.highlights).toEqual([
    expect.objectContaining({ quote: 'octopus', start: 3, end: 10 }),
  ]);
});

test('serializes note suggestions, concurrent saves, and undo/redo', async () => {
  const row = await db
    .prepare("SELECT * FROM turns WHERE request_id='real-request'")
    .first<turns.TurnRow>();
  const suggestion = await persistNoteSuggestion(db, {
    ownerId: 'owner',
    conversationId: 'chat',
    branchId: 'a',
    sourceMessageId: row!.id,
    expectedNoteId: null,
    expectedRevision: null,
    proposal: {
      id: 'suggestion',
      noteId: '',
      baseRevision: 0,
      status: 'pending',
      oldText: '',
      newText: 'Eight arms.',
      reason: 'Save fact.',
    },
  });
  expect(suggestion.created).toBe(true);
  expect(
    (
      await cancelNoteSuggestionAttempt(db, {
        ownerId: 'owner',
        conversationId: 'chat',
        branchId: 'a',
        sourceMessageId: row!.id,
        attemptId: 'suggestion',
      })
    ).cancelledSuggestionIds,
  ).toEqual(['suggestion']);
  const saves = await Promise.allSettled(
    ['save-a', 'save-b'].map((operationId) =>
      saveNote(db, 'owner', suggestion.noteId, {
        operationId,
        baseRevision: 1,
        markdown: operationId,
        provenance: [],
      }),
    ),
  );
  expect(saves.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    await db
      .prepare('SELECT COUNT(*) AS count FROM note_edits WHERE note_id=?')
      .bind(suggestion.noteId)
      .first(),
  ).toEqual({ count: 2 });
  const undone = await moveNoteHistory(db, 'owner', suggestion.noteId, 'undo', {
    operationId: 'undo-save',
    baseRevision: 2,
  });
  expect(undone.note.markdown).toBe('');
  const redone = await moveNoteHistory(db, 'owner', suggestion.noteId, 'redo', {
    operationId: 'redo-save',
    baseRevision: 3,
  });
  expect(redone.note.markdown).toMatch(/^save-/);
});

test('authenticates with the real Better Auth PG Drizzle adapter and revokes reset sessions', async () => {
  const env = {
    DB: db,
    AUTH_MODE: 'better-auth',
    BETTER_AUTH_SECRET: 'postgres-better-auth-test-secret-123456789',
    BETTER_AUTH_URL: 'http://localhost:8787',
  } as Bindings;
  env.AUTH = createDrizzleAuth(drizzle(pool), 'pg', env);
  const account = await createAccount(env, {
    email: 'pg-owner@test.example',
    name: 'PG Owner',
    password: 'pg-owner-password-123',
  });
  const login = await env.AUTH.handler(
    new Request('http://localhost:8787/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' },
      body: JSON.stringify({ email: 'pg-owner@test.example', password: 'pg-owner-password-123' }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await env.AUTH.api.getSession({ headers: new Headers({ cookie }) }))?.user.id).toBe(
    account.authUserId,
  );
  await resetAccountPassword(env, account.authUserId, 'pg-owner-replacement-123');
  expect(await env.AUTH.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
});

async function seedCompletedConversation() {
  await db.prepare("UPDATE turns SET status='completed'").run();
  await db.prepare('DELETE FROM message_windows').run();
  const request = {
    requestId: 'real-request',
    conversationId: 'chat',
    branchId: 'a',
    noteRevision: null,
    message: 'Question about octopuses',
    personaId: 'thinking-partner',
    action: 'message' as const,
  };
  const result = await prepareTurn(
    { db, ownerId: 'owner', messageLimit: { limit: 4, windowHours: 4 } },
    request,
  );
  expect(result.kind).toBe('stream');
  if (result.kind !== 'stream') throw new Error('Expected streaming admission');
  await db
    .prepare('UPDATE turns SET user_message_id=? WHERE id=?')
    .bind(result.turn.userMessageId, result.turn.turnId)
    .run();
  const row = await turns.claimTurnExecution(db, result.turn.turnId);
  expect(row).toBeTruthy();
  await turns.completeTurn(db, row!, [
    { type: 'start', messageId: row!.id },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: 'An octopus has eight arms.' },
    { type: 'text-end', id: 'text' },
  ]);
  const conversation = await loadConversation(db, 'owner', 'chat', { branchId: 'a' });
  expect(conversation.messages).toHaveLength(2);
  expect(conversation.messages[1]?.metadata?.status).toBe('complete');
  return row!;
}

test('preserves all application data across PostgreSQL and SQLite transfers', async () => {
  // Earlier concurrency fixtures intentionally leave admitted turns; settle them before migration.
  await db.prepare("UPDATE turns SET status='completed' WHERE status='streaming'").run();
  const original = await exportApplicationSnapshot(db);
  expect(original.tables.turns.some((turn) => turn.status === 'streaming')).toBe(false);
  const sqlite = openSqliteDatabase(':memory:');
  const restoredSqlite = openSqliteDatabase(':memory:');
  let targetPool: import('pg').Pool | undefined;
  try {
    await applySqliteMigrations(sqlite, new URL('../../../migrations/', import.meta.url));
    await applySqliteMigrations(restoredSqlite, new URL('../../../migrations/', import.meta.url));
    await importApplicationSnapshot(sqlite, original);
    const sqliteCopy = await exportApplicationSnapshot(sqlite);
    await pool.query('CREATE DATABASE walden_transfer');
    const { Pool } = await import('pg');
    const url = new URL(pool.options.connectionString!);
    url.pathname = '/walden_transfer';
    targetPool = new Pool({ connectionString: url.toString() });
    await migratePostgres(targetPool);
    const target = createPostgresDatabase(targetPool);
    const unsettled = structuredClone(original);
    expect(unsettled.tables.turns.length).toBeGreaterThan(0);
    unsettled.tables.turns[0].status = 'streaming';
    await expect(importApplicationSnapshot(target, unsettled)).rejects.toThrow(/settled turns/);
    expect(await target.prepare('SELECT count(*) AS total FROM users').first('total')).toBe(0);
    await importApplicationSnapshot(target, sqliteCopy);
    await importApplicationSnapshot(restoredSqlite, await exportApplicationSnapshot(target));
    const restored = await exportApplicationSnapshot(restoredSqlite);
    expect(restored.tables).toEqual(original.tables);
    await expect(importApplicationSnapshot(target, original)).rejects.toThrow(/empty target/);
  } finally {
    sqlite.close();
    restoredSqlite.close();
    await targetPool?.end();
  }
});

test('indexes public research with PostgreSQL full text, semantic fusion, owner privacy and durable restart', async () => {
  const { makeIndex, signal, original, fail } = await researchFixture();
  try {
    expect(await makeIndex().upsert(original, signal)).toMatchObject({ status: 'complete' });
    expect(
      await makeIndex().upsert(
        {
          ownerScope: 'pg-research-alice',
          url: 'https://example.com/reference',
          markdown: 'ZXQ9981 is a product reference.',
        },
        signal,
      ),
    ).toMatchObject({ status: 'complete' });
    await makeIndex().upsert(
      {
        ownerScope: 'pg-research-bob',
        url: 'https://example.com/bob',
        markdown: 'A puppy belongs to Bob.',
      },
      signal,
    );
    expect((await makeIndex().search('pg-research-alice', 'puppy', signal)).results[0]?.url).toBe(
      original.url,
    );
    expect((await makeIndex().search('pg-research-alice', 'ZXQ9981', signal)).results[0]?.url).toBe(
      'https://example.com/reference',
    );
    expect((await makeIndex().search('pg-research-nobody', 'puppy', signal)).results).toEqual([]);
    fail(true);
    expect(
      await makeIndex().upsert({ ...original, markdown: 'A puppy enjoys fresh air.' }, signal),
    ).toMatchObject({ status: 'failed' });
    expect(
      await db
        .prepare('SELECT text FROM research_chunks WHERE owner_scope=? AND text=?')
        .bind('pg-research-alice', original.markdown)
        .first('text'),
    ).toBe(original.markdown);
    fail(false);
    await makeIndex().resume();
    expect((await makeIndex().search('pg-research-alice', 'puppy', signal)).results[0]?.text).toBe(
      'A puppy enjoys fresh air.',
    );
    await makeIndex().deleteOwner('pg-research-alice');
    expect((await makeIndex().search('pg-research-alice', 'puppy', signal)).results).toEqual([]);
    expect((await makeIndex().search('pg-research-bob', 'puppy', signal)).results[0]?.url).toBe(
      'https://example.com/bob',
    );
  } finally {
    await makeIndex().deleteOwner('pg-research-alice');
    await makeIndex().deleteOwner('pg-research-bob');
  }
});

async function researchFixture() {
  const { createLocalSavedSources } = await import('./research/saved-sources');
  const objects = new Map<string, string>();
  const blobs = {
    async put(key: string, value: string) {
      objects.set(key, value);
      return { key };
    },
    async get(key: string) {
      const text = objects.get(key);
      return text === undefined ? null : { text: async () => text };
    },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  } as unknown as import('../../storage/object-store').ObjectStore;
  let failing = false;
  const embedder: import('./research/embeddings').ResearchEmbedder = {
    revision: 'pg-fixture-minilm-384',
    async embed(texts) {
      if (failing) throw new Error('Injected embedding failure');
      return texts.map((text) => {
        const vector = Array(384).fill(0) as number[];
        vector[/puppy|canine/i.test(text) ? 0 : 1] = 1;
        return vector;
      });
    },
  };
  const makeIndex = () => createLocalSavedSources({ db, blobs, embedder });
  const signal = new AbortController().signal;
  const original = {
    ownerScope: 'pg-research-alice',
    url: 'https://example.com/canine',
    markdown: 'A canine plays in the park.',
  };
  return {
    makeIndex,
    signal,
    original,
    fail: (value: boolean) => {
      failing = value;
    },
  };
}

test('keeps one persona available under concurrent PostgreSQL deletes', async () => {
  for (const persona of DEFAULT_PERSONAS.slice(0, -2))
    await db
      .prepare('INSERT INTO hidden_personas VALUES(?,?,?)')
      .bind('owner', persona.id, 'now')
      .run();
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message }, 409));
  app.route('/api/personas', personaRoutes);
  const responses = await Promise.all(
    DEFAULT_PERSONAS.slice(-2).map((persona) =>
      app.request(`/api/personas/${persona.id}`, { method: 'DELETE' }, {
        DB: db,
      } as unknown as Bindings),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([204, 409]);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM hidden_personas WHERE owner_id='owner'")
      .first(),
  ).toEqual({ count: DEFAULT_PERSONAS.length - 1 });
});

test('rejects newer or changed migration histories without touching application data', async () => {
  await pool.query(
    "INSERT INTO walden_migrations(version,checksum) VALUES('9999_future.sql','future')",
  );
  try {
    await expect(migratePostgres(pool)).rejects.toThrow(/missing/);
  } finally {
    await pool.query("DELETE FROM walden_migrations WHERE version='9999_future.sql'");
  }
  await pool.query(
    "UPDATE walden_migrations SET checksum='changed' WHERE version='0000_baseline.sql'",
  );
  try {
    await expect(migratePostgres(pool)).rejects.toThrow(/changed/);
  } finally {
    await pool.query("UPDATE walden_migrations SET checksum=$1 WHERE version='0000_baseline.sql'", [
      (await import('node:crypto'))
        .createHash('sha256')
        .update(
          await (await import('node:fs/promises')).readFile(
            new URL('../../../postgres-migrations/0000_baseline.sql', import.meta.url),
          ),
        )
        .digest('hex'),
    ]);
  }
  expect(await db.prepare("SELECT id FROM users WHERE id='owner'").first()).toEqual({
    id: 'owner',
  });
});

test('fences execution and completion once account deletion is pending', async () => {
  await db.prepare("UPDATE turns SET status='streaming' WHERE request_id='real-request'").run();
  const row = await db
    .prepare("SELECT * FROM turns WHERE request_id='real-request'")
    .first<turns.TurnRow>();
  await db.prepare("UPDATE users SET deletion_pending=1 WHERE id='owner'").run();
  try {
    expect(await turns.isConversationLive(db, 'owner', 'chat')).toBe(false);
    expect(await turns.isTurnActive(db, row!.id, row!.execution_generation)).toBe(false);
    expect(await turns.claimTurnExecution(db, row!.id)).toBeNull();
    expect(await turns.completeTurn(db, row!, [])).toBeNull();
  } finally {
    await db.prepare("UPDATE users SET deletion_pending=0 WHERE id='owner'").run();
    await db.prepare("UPDATE turns SET status='completed'").run();
  }
});

test('keeps newer generation annotations when completion timestamps are identical', async () => {
  const row = await db
    .prepare("SELECT * FROM turns WHERE request_id='real-request'")
    .first<turns.TurnRow & { completed_at: string }>();
  await db
    .prepare(
      "INSERT INTO message_highlights(message_id,owner_id,origin,start,\"end\",quote,kind,updated_at) VALUES(?,'owner','agent',0,2,'An','fact','now')",
    )
    .bind(row!.id)
    .run();
  await db.batch(
    agentHighlightStatements(db, {
      messageId: row!.id,
      ownerId: 'owner',
      content: 'An octopus has eight arms.',
      annotations: [],
      updatedAt: row!.completed_at,
      completedAt: row!.completed_at,
      executionGeneration: row!.execution_generation! - 1,
    }),
  );
  expect(
    (
      await db
        .prepare("SELECT quote FROM message_highlights WHERE message_id=? AND origin='agent'")
        .bind(row!.id)
        .all()
    ).results,
  ).toEqual([{ quote: 'An' }]);
});

test('refuses oversized model weights without creating or reopening PostgreSQL windows', async () => {
  await db.prepare("DELETE FROM message_windows WHERE owner_id='owner'").run();
  const limit = { limit: 1, windowHours: 4 };
  await expect(chargeMessage(db, 'owner', limit, 3)).rejects.toMatchObject({
    status: 429,
    details: { code: 'message_limit', weight: 3 },
  });
  expect(
    await db.prepare("SELECT * FROM message_windows WHERE owner_id='owner'").first(),
  ).toBeNull();
  await db
    .prepare("INSERT INTO message_windows VALUES('owner','2000-01-01T00:00:00.000Z',1)")
    .run();
  await expect(chargeMessage(db, 'owner', limit, 3)).rejects.toMatchObject({
    status: 429,
    details: { code: 'message_limit', weight: 3 },
  });
  expect(
    await db.prepare("SELECT started_at,used FROM message_windows WHERE owner_id='owner'").first(),
  ).toEqual({ started_at: '2000-01-01T00:00:00.000Z', used: 1 });
});
