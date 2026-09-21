import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { accountRoutes } from './account';
import { sqliteD1Binding } from './agent/d1-test-binding';
import type { Bindings, Variables } from './types';

async function expectOwnedExport(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  db: D1Database,
) {
  const response = await app.request('/account/export', {}, { DB: db } as Bindings);
  expect(response.status).toBe(200);
  const exported = (await response.json()) as Record<
    string,
    Array<{ id: string; markdown?: string }>
  >;
  for (const table of ['conversations', 'branches', 'messages'])
    expect(exported[table]?.map(({ id }) => id)).toEqual(['current']);
  expect(exported.highlights).toEqual([
    {
      message_id: 'current',
      origin: 'user',
      start: 0,
      end: 5,
      quote: 'Trans',
      color: 'blue',
      kind: null,
      updated_at: '1',
    },
    {
      message_id: 'current',
      origin: 'user',
      start: 5,
      end: 10,
      quote: 'cript',
      color: null,
      kind: null,
      updated_at: '2',
    },
  ]);
  expect(exported.notes).toEqual([
    expect.objectContaining({ id: 'note', markdown: 'Keep permanently' }),
  ]);
  expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(4);
}

function ownerApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/', accountRoutes);
  return app;
}

it('exports only current owned transcripts even before cleanup, while preserving expired-thread notes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-export-'));
  try {
    const file = join(directory, 'fixture.sqlite');
    const migrations = new URL('../migrations/', import.meta.url);
    execFileSync('sqlite3', [file], {
      input: readdirSync(migrations)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
        .join('\n'),
    });
    const db = sqliteD1Binding(file);
    await db
      .prepare(
        "INSERT INTO users VALUES ('owner','subject','now','now',0),('other','other','now','now',0)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO notes (id,owner_id,markdown,created_at,updated_at) VALUES ('note','owner','Keep permanently','now','now')",
      )
      .run();
    for (const [id, owner, expiry, status, note] of [
      ['current', 'owner', '2999-01-01', 'active', null],
      ['expired', 'owner', '2000-01-01', 'active', 'note'],
      ['inactive', 'owner', '2999-01-01', 'expired', null],
      ['unowned', 'other', '2999-01-01', 'active', null],
    ]) {
      await db
        .prepare(
          "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES (?,?,?,'Title','now',?,?,'now')",
        )
        .bind(id, owner, note, expiry, status)
        .run();
      await db
        .prepare(
          "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,last_user_activity_at,expires_at,created_at) VALUES (?,?,?,1,?,'now',?,'now')",
        )
        .bind(id, id, owner, status, expiry)
        .run();
      await db
        .prepare(
          "INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at,origin_branch_id) VALUES (?,?,?,'assistant','Transcript',1,'now',?)",
        )
        .bind(id, id, owner, id)
        .run();
    }
    await db
      .prepare(
        "INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,color,updated_at) SELECT id,owner_id,'user',0,5,'Trans','blue','1' FROM messages",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,color,updated_at) VALUES ('current','owner','user',5,10,'cript',NULL,'2')",
      )
      .run();
    await expectOwnedExport(ownerApp(), db);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
