import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, TurnStart, WaldenUIMessage } from '@walden/contracts';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { conversationRoutes } from '../../conversations/conversations';
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
  await DB.prepare(
    "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('owner','subject','now','now',0)",
  ).run();
  await DB.prepare(
    "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('other','other','now','now',0)",
  ).run();
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
    AI: {} as Ai,
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
  app.route('/api', conversationRoutes);
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

it('returns the admitted canonical user message while committed conversation history still excludes it', async () => {
  const { DB, env, app, start } = await fixture();
  const admitted = await start('recover', 'Question still being answered');
  expect(admitted.status).toBe(200);
  const { turnId, userMessageId } = (await admitted.json()) as TurnStart;
  const stored = await DB.prepare('SELECT ui_message FROM messages WHERE id=?')
    .bind(userMessageId)
    .first<{ ui_message: string }>();
  const conversation = await app.request('/api/conversations/chat?branch=branch', {}, env);
  expect(conversation.status).toBe(200);
  expect(((await conversation.json()) as Conversation).messages).toEqual([]);
  const active = await app.request('/api/chat/turns?conversationId=chat&branchId=branch', {}, env);
  expect(active.status).toBe(200);
  expect(await active.json()).toMatchObject({
    turn: { id: turnId, userMessageId, userMessage: JSON.parse(stored!.ui_message) },
  });
  expect(
    await DB.prepare('SELECT head_message_id FROM conversation_branches WHERE id=?')
      .bind('branch')
      .first(),
  ).toEqual({ head_message_id: null });
});

it('scopes recovered user messages to the admitted owner and conversation while allowing regeneration reuse', async () => {
  const { DB, env, app, start } = await fixture();
  const { turnId, userMessageId } = (await (await start('original')).json()) as TurnStart;
  await DB.prepare("UPDATE turns SET status='completed' WHERE id=?").bind(turnId).run();
  await DB.prepare(
    "INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id,user_message_id) VALUES('regenerated','regenerate','chat','owner','streaming','later','branch','branch',?)",
  )
    .bind(userMessageId)
    .run();
  const active = () => app.request('/api/chat/turns?conversationId=chat&branchId=branch', {}, env);
  const payload = (await (await active()).json()) as { turn: { userMessage?: WaldenUIMessage } };
  expect(payload.turn.userMessage?.id).toBe(userMessageId);
  // A corrupted cross-owner reference must never disclose the other owner's message.
  await DB.prepare('UPDATE messages SET owner_id=? WHERE id=?').bind('other', userMessageId).run();
  const foreignOwner = (await (await active()).json()) as { turn: object };
  expect(foreignOwner).toMatchObject({ turn: { id: 'regenerated' } });
  expect(foreignOwner.turn).not.toHaveProperty('userMessage');
  await DB.prepare(
    "INSERT INTO conversations(id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES('another','owner','Other','now','2999-01-01','active','now')",
  ).run();
  await DB.prepare('UPDATE messages SET owner_id=?,conversation_id=? WHERE id=?')
    .bind('owner', 'another', userMessageId)
    .run();
  expect(((await (await active()).json()) as { turn: object }).turn).not.toHaveProperty(
    'userMessage',
  );
  await DB.prepare("UPDATE turns SET user_message_id=NULL WHERE id='regenerated'").run();
  const reserved = (await (await active()).json()) as { turn: object };
  expect(reserved).toMatchObject({
    turn: { userMessageId: null },
  });
  expect(reserved.turn).not.toHaveProperty('userMessage');
});

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
        { headers: { 'x-owner': 'other', 'X-Walden-Turn-Protocol': '2' } },
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
  const events = await (
    await app.request(
      `/api/chat/turns/${turnId}/events`,
      { headers: { 'X-Walden-Turn-Protocol': '2' } },
      env,
    )
  ).text();
  expect(events).toContain('"type":"error"');
  expect(events.trimEnd().endsWith('data: [DONE]')).toBe(true);
});

it('reports the send that used up the budget and each send refused at the limit', async () => {
  const { DB, env, start } = await fixture();
  Object.assign(env, { MESSAGE_LIMIT: '1', POSTHOG_API_KEY: 'phc_test' });
  const events: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      events.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 200 });
    }),
  );
  try {
    const admitted = await start('first');
    expect(((await admitted.json()) as TurnStart).budget).toMatchObject({ used: 1, limit: 1 });
    await DB.prepare("UPDATE turns SET status='completed'").run();
    expect((await start('second', 'Another question')).status).toBe(429);
    await vi.waitFor(() => expect(events).toHaveLength(2));
  } finally {
    vi.unstubAllGlobals();
  }
  expect(events.map(({ event }) => event)).toEqual([
    'message_limit_reached',
    'message_limit_blocked',
  ]);
  expect(events[0]?.properties).toMatchObject({
    used: 1,
    limit: 1,
    window_hours: 4,
    turns_in_window: 1,
    ms_since_window_start: expect.any(Number),
    model: '@cf/zai-org/glm-5.3-flash',
    weight: 1,
  });
  expect(events[1]?.properties).toMatchObject({ used: 1, ms_until_reset: expect.any(Number) });
});
it('rejects an unsupported default model before storing or charging a turn', async () => {
  const { DB, env, start } = await fixture();
  Object.assign(env, {
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: 'http://localhost:1234/v1',
    AI_MODEL: 'embedding-only',
    AI_MODELS_JSON: JSON.stringify([
      {
        id: 'embedding-only',
        inputModalities: ['text'],
        outputModalities: ['embeddings'],
        supportsTools: false,
      },
    ]),
  });
  const response = await start('unsupported-model');
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: expect.stringMatching(/text conversations with tools/),
  });
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM message_windows').first()).toEqual({
    count: 0,
  });
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM turns').first()).toEqual({ count: 0 });
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).toEqual({ count: 0 });
});
