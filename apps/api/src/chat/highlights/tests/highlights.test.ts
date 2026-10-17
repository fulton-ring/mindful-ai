import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { loadConversation } from '../../conversations/repository';
import { highlightRoutes } from '../highlights';

let db: D1Database;

const request = (ownerId: string, body: unknown) => {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', ownerId);
    await next();
  });
  app.route('/api/chat', highlightRoutes);
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof HttpError ? error.status : 500),
  );
  return app.request(
    '/api/chat/messages/message/highlights',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DB: db } as Bindings,
  );
};

async function createHighlightsDatabase(): Promise<D1Database> {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-highlights-')), 'fixture.sqlite');
  const migrations = new URL('../../../../migrations/', import.meta.url);
  execFileSync('sqlite3', [file], {
    input: readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n'),
  });
  const database = sqliteD1Binding(file);
  await database
    .prepare(
      "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('owner','subject','now','now',0)",
    )
    .run();
  await database
    .prepare(
      "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('other','other-subject','now','now',0)",
    )
    .run();
  await database
    .prepare(
      "INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','Title','now','2999-01-01','active','now')",
    )
    .run();
  await database
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,head_message_id,is_default,status,created_at) VALUES ('branch','conversation','owner',NULL,1,'active','now')",
    )
    .run();
  await database
    .prepare(
      "INSERT INTO messages (id,conversation_id,owner_id,role,ui_message,created_at,origin_branch_id) VALUES ('message','conversation','owner','assistant',json_object('id','message','role','assistant','parts',json_array(json_object('type','text','text','A😀B answer')),'metadata',json_object('createdAt','now')),'now','branch')",
    )
    .run();
  await database
    .prepare("UPDATE conversation_branches SET head_message_id='message' WHERE id='branch'")
    .run();
  return database;
}

describe('saved message highlights', () => {
  beforeEach(async () => {
    db = await createHighlightsDatabase();
  });

  it('validates raw UTF-16 ranges and rejects another owner', async () => {
    expect(
      (await request('owner', { start: 1, end: 3, quote: '😀', color: 'yellow' })).status,
    ).toBe(200);
    expect((await request('owner', { start: 1, end: 2, quote: '😀', color: 'green' })).status).toBe(
      400,
    );
    expect((await request('other', { start: 1, end: 3, quote: '😀', color: 'green' })).status).toBe(
      404,
    );
  });

  it('upserts a durable tombstone, survives annotation writes, hydrates, and cascades', async () => {
    await request('owner', { start: 5, end: 11, quote: 'answer', color: 'blue' });
    await request('owner', { start: 5, end: 11, quote: 'answer', color: null });
    await db
      .prepare(
        "INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,color,kind,updated_at) VALUES ('message','owner','agent',0,4,'The ',NULL,'fact','2026-01-01T00:00:00.000Z')",
      )
      .run();

    const conversation = await loadConversation(db, 'owner', 'conversation', {
      branchId: 'branch',
    });
    // The user tombstone hydrates; the agent row is surfaced as an annotation.
    expect(conversation.messages[0]?.metadata?.highlights).toEqual([
      { start: 5, end: 11, quote: 'answer', color: null, origin: 'user' },
    ]);
    expect(conversation.messages[0]?.metadata?.annotations).toEqual([
      { id: 'agent:message:0', quote: 'The ', kind: 'fact', whose: 'assistant' },
    ]);
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM message_highlights WHERE message_id='message'")
        .first(),
    ).toEqual({ count: 2 });

    await db.prepare("DELETE FROM messages WHERE id='message'").run();
    expect(await db.prepare('SELECT count(*) AS count FROM message_highlights').first()).toEqual({
      count: 0,
    });
  });

  it('hydrates overlapping ranges from oldest update to newest update', async () => {
    await db
      .prepare(
        "INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,color,updated_at) VALUES ('message','owner','user',1,3,'😀','yellow','2026-01-01T00:00:00.000Z'),('message','owner','user',0,4,'A😀B','blue','2026-01-01T00:00:01.000Z')",
      )
      .run();
    await db
      .prepare(
        "UPDATE message_highlights SET color=NULL,updated_at='2026-01-01T00:00:02.000Z' WHERE message_id='message' AND start=1 AND end=3",
      )
      .run();

    const conversation = await loadConversation(db, 'owner', 'conversation', {
      branchId: 'branch',
    });

    expect(conversation.messages[0]?.metadata?.highlights).toEqual([
      { start: 0, end: 4, quote: 'A😀B', color: 'blue', origin: 'user' },
      { start: 1, end: 3, quote: '😀', color: null, origin: 'user' },
    ]);
  });
});
