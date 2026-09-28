import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnStart } from '@walden/contracts';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { chatRoutes } from '../routes';
import { turnObjects } from './turn-fixture';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-admission-')), 'db.sqlite');
  const migrations = new URL('../../../../migrations/', import.meta.url);
  execFileSync('sqlite3', [file], {
    input: readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n'),
  });
  const DB = sqliteD1Binding(file);
  await DB.prepare("INSERT INTO users VALUES ('owner','subject','now','now',0)").run();
  await DB.prepare("INSERT INTO users VALUES ('other','other','now','now',0)").run();
  await DB.prepare(
    "INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('chat','owner','Title','now','2999-01-01','active','now')",
  ).run();
  await DB.prepare(
    "INSERT INTO conversation_branches (id,conversation_id,owner_id,head_message_id,is_default,created_at) VALUES ('branch','chat','owner',NULL,1,'now')",
  ).run();
  // Admitted turns are never run here: Stop seals them as the object would a turn it holds.
  const objects = turnObjects(() => env);
  const env = {
    DB,
    CHAT_TURN: {
      idFromName: (name: string) => name,
      get: (turnId: string) => ({
        start: async () => undefined,
        stop: (id: string) => objects.session(turnId).stop(id),
        stream: (id: string, after: number) => objects.session(turnId).stream(id, after),
      }),
    },
  } as unknown as Bindings;
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-owner') ?? 'owner');
    c.set('authSubject', 'subject');
    await next();
  });
  app.route('/api/chat', chatRoutes);
  app.onError((error, c) =>
    error instanceof HttpError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: 'internal' }, 500),
  );
  const start = (requestId: string, message = 'Question') =>
    app.request(
      '/api/chat/turns',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          conversationId: 'chat',
          branchId: 'branch',
          noteRevision: null,
          message,
          personaId: 'thinking-partner',
          action: 'message',
        }),
      },
      env,
    );
  return { DB, env, app, start };
}

it('admits one immutable turn, protects replay, and persists Stop', async () => {
  const { DB, env, app, start } = await fixture();
  const [a, b] = await Promise.all([start('same'), start('same')]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const { turnId, userMessageId } = (await a.json()) as TurnStart;
  expect(
    await DB.prepare('SELECT user_message_id FROM turns WHERE id=?').bind(turnId).first(),
  ).toEqual({ user_message_id: userMessageId });
  expect(((await b.json()) as { turnId: string }).turnId).toBe(turnId);
  expect(
    (await DB.prepare('SELECT COUNT(*) AS count FROM turns').first<{ count: number }>())?.count,
  ).toBe(1);
  expect(await DB.prepare('SELECT model,weight FROM turns').first()).toEqual({
    model: '@cf/zai-org/glm-5.3-flash',
    weight: 1,
  });
  const user = await DB.prepare("SELECT id,ui_message FROM messages WHERE role='user'").first<{
    id: string;
    ui_message: string;
  }>();
  expect(JSON.parse(user!.ui_message)).toEqual({
    id: user!.id,
    role: 'user',
    parts: [{ type: 'text', text: 'Question' }],
    metadata: { createdAt: expect.any(String) },
  });
  expect((await start('same', 'Changed')).status).toBe(409);
  expect((await start('another')).status).toBe(409);
  // One admitted turn is charged once; replays and refused turns cost nothing.
  expect(await DB.prepare('SELECT used FROM message_windows').first()).toEqual({ used: 1 });
  expect(
    (
      await app.request(
        `/api/chat/turns/${turnId}/events`,
        { headers: { 'x-owner': 'other' } },
        env,
      )
    ).status,
  ).toBe(404);
  expect(
    (await app.request(`/api/chat/turns/${turnId}/cancel`, { method: 'POST' }, env)).status,
  ).toBe(200);
  expect(await DB.prepare('SELECT status FROM turns WHERE id=?').bind(turnId).first()).toEqual({
    status: 'cancelled',
  });
  expect(
    (await DB.prepare('SELECT request_id FROM turn_cancellations').first<{ request_id: string }>())
      ?.request_id,
  ).toBe('same');
  // Stop leaves an interrupted reply, and its stream replays to a terminal [DONE].
  const events = await (await app.request(`/api/chat/turns/${turnId}/events`, {}, env)).text();
  expect(events).toContain('"type":"error"');
  expect(events.trimEnd().endsWith('data: [DONE]')).toBe(true);
});
