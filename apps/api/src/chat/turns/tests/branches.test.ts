import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import { uiMessageText } from '@walden/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import { uiMessageSql } from '../../../tests/ui-messages';
import type { Bindings, Variables } from '../../../types';
import { readTurnStream, turnObjects } from './turn-fixture';

const mocks = vi.hoisted(() => ({ streamTurn: vi.fn(), updateMemory: vi.fn() }));
vi.mock('../../../services/agent/agent', () => ({
  createAgentService: () => ({ streamTurn: mocks.streamTurn, updateMemory: mocks.updateMemory }),
  modelNameForPersona: () => '@cf/zai-org/glm-5.3-flash',
}));

import { loadConversation } from '../../conversations/repository';
import { chatRoutes } from '../routes';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-branches-')), 'fixture.sqlite');
  const migrations = new URL('../../../../migrations/', import.meta.url);
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
      "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('owner','subject','now','now',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','Title','now','2999-01-01','active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,head_message_id,is_default,created_at) VALUES ('default','conversation','owner',NULL,1,'now')",
    )
    .run();
  const rows = [
    ['u1', 'user', 'First', null],
    ['a1', 'assistant', 'Original answer', 'u1'],
    ['u2', 'user', 'Later', 'a1'],
    ['a2', 'assistant', 'Later answer', 'u2'],
  ] as const;
  for (const [id, role, content, parent] of rows)
    await db
      .prepare(
        `INSERT INTO messages (id,conversation_id,owner_id,role,created_at,parent_message_id,origin_branch_id,ui_message) VALUES (?,'conversation','owner',?,'now',?,'default',${uiMessageSql(id, role, content, role === 'assistant' ? { status: 'complete' } : {})})`,
      )
      .bind(id, role, parent)
      .run();
  await db
    .prepare("UPDATE conversation_branches SET head_message_id='a2' WHERE id='default'")
    .run();
  return db;
}

async function requestTurn(db: Bindings['DB'], payload: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    c.set('authSubject', 'subject');
    await next();
  });
  app.route('/api/chat', chatRoutes);
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ error: error.message }, error.status) : c.json({}, 500),
  );
  const objects = turnObjects(() => env);
  const env = { DB: db, AI: {}, CHAT_TURN: objects.namespace } as unknown as Bindings;
  const response = await app.fetch(
    new Request('https://walden.test/api/chat/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
    { waitUntil: () => undefined } as unknown as ExecutionContext,
  );
  if (!response.ok) throw new Error(await response.text());
  const { turnId } = (await response.json()) as { turnId: string };
  const { chunks, done } = await readTurnStream(await objects.session(turnId).stream(turnId, 0));
  expect(done).toBe(true);
  return chunks;
}

/** The branch the turn ran on, from its opening `data-turn` chunk. */
function turnBranch(chunks: WaldenUIMessageChunk[]) {
  const turn = chunks.find((chunk) => chunk.type === 'data-turn');
  return turn?.type === 'data-turn' ? turn.data.branchId : undefined;
}

const answer = (id: string, text: string): WaldenUIMessageChunk[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: text },
  { type: 'text-end', id },
];
const replying = (...chunks: WaldenUIMessageChunk[]) =>
  (async function* () {
    yield* chunks;
  })();
const texts = (messages: Parameters<typeof uiMessageText>[0][]) => messages.map(uiMessageText);

const failureCases = [
  {
    failure: 'The response reached its output limit. Please ask for a shorter answer.',
    expected: 'The response reached its output limit. Please ask for a shorter answer.',
    expectedCode: 'output_limit',
  },
  {
    failure:
      'Workers AI API error (429 Too Many Requests): {"errors":[{"message":"you have used up your daily free allocation of 10,000 neurons","code":4006}]}',
    expected:
      'AI replies are unavailable because the provider’s daily allowance has been reached. Try again after it resets.',
    expectedCode: 'quota_exhausted',
  },
  {
    failure:
      'Workers AI API error (429 Too Many Requests): {"errors":[{"message":"Rate limit exceeded"}]}',
    expected: 'The AI service is busy. Please try again shortly.',
    expectedCode: 'rate_limited',
  },
  {
    failure:
      'Workers AI API error (503 Service Unavailable): {"errors":[{"message":"internal provider details"}]}',
    expected: 'The AI service could not complete this response. Please try again.',
    expectedCode: 'provider_unavailable',
  },
];

describe('conversation branches: regeneration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('regenerates an older response into a sibling branch without changing the original path', async () => {
    const db = await fixture();
    mocks.streamTurn.mockImplementation(async () => replying(...answer('t', 'Replacement answer')));
    const chunks = await requestTurn(db, {
      requestId: 'regenerate',
      conversationId: 'conversation',
      branchId: 'default',
      noteRevision: null,
      message: 'ignored',
      personaId: 'thinking-partner',
      regenerateMessageId: 'a1',
    });
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      messageMetadata: { status: 'complete' },
    });
    const branchId = turnBranch(chunks)!;
    expect(branchId).not.toBe('default');
    expect(mocks.streamTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ branchId, messages: [] }),
      }),
      expect.any(AbortSignal),
    );
    const branch = await loadConversation(db, 'owner', 'conversation', { branchId });
    expect(texts(branch.messages)).toEqual(['First', 'Replacement answer']);
    const original = await loadConversation(db, 'owner', 'conversation', { branchId: 'default' });
    expect(original.messages.map(({ id }) => id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(texts(original.messages)).toEqual(['First', 'Original answer', 'Later', 'Later answer']);
  });
});

describe('conversation branches: editing', () => {
  beforeEach(() => vi.clearAllMocks());
  it('edits a prompt into a sibling branch without appending to the original path', async () => {
    const db = await fixture();
    mocks.streamTurn.mockImplementation(
      async (input: { conversation: { messages: { id: string }[] }; message: string }) => {
        expect(input.conversation.messages.map(({ id }) => id)).toEqual(['u1', 'a1']);
        expect(input.message).toBe('Edited prompt');
        return replying(...answer('t', 'Edited answer'));
      },
    );
    const chunks = await requestTurn(db, {
      requestId: 'edit-message',
      conversationId: 'conversation',
      branchId: 'default',
      noteRevision: null,
      message: 'Edited prompt',
      personaId: 'thinking-partner',
      editMessageId: 'u2',
    });
    const edited = await loadConversation(db, 'owner', 'conversation', {
      branchId: turnBranch(chunks)!,
    });
    expect(texts(edited.messages)).toEqual([
      'First',
      'Original answer',
      'Edited prompt',
      'Edited answer',
    ]);
    const original = await loadConversation(db, 'owner', 'conversation', { branchId: 'default' });
    expect(original.messages.map(({ id }) => id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});

describe('conversation branches: interrupted responses', () => {
  beforeEach(() => vi.clearAllMocks());
  it('retries an edited prompt in place when its response was interrupted', async () => {
    const db = await fixture();
    await db
      .prepare(
        `UPDATE messages SET ui_message=${uiMessageSql('a2', 'assistant', '', { status: 'interrupted' })} WHERE id='a2'`,
      )
      .run();
    mocks.streamTurn.mockResolvedValue(replying(...answer('t', 'Recovered answer')));
    const chunks = await requestTurn(db, {
      requestId: 'retry-edited-message',
      conversationId: 'conversation',
      branchId: 'default',
      noteRevision: null,
      message: 'Repaired prompt',
      personaId: 'thinking-partner',
      editMessageId: 'u2',
    });
    expect(turnBranch(chunks)).toBe('default');
    const reloaded = await loadConversation(db, 'owner', 'conversation', { branchId: 'default' });
    expect(texts(reloaded.messages)).toEqual([
      'First',
      'Original answer',
      'Repaired prompt',
      'Recovered answer',
    ]);
    expect(reloaded.messages.map(({ id }) => id).slice(0, 3)).toEqual(['u1', 'a1', 'u2']);
    expect(await db.prepare('SELECT count(*) AS count FROM conversation_branches').first()).toEqual(
      { count: 1 },
    );
  });
});

describe('conversation branches: failures', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(failureCases)(
    'preserves partial output and presents a readable failure: $expected',
    async ({ failure, expected, expectedCode }) => {
      const db = await fixture();
      mocks.streamTurn.mockResolvedValue(
        (async function* () {
          yield* answer('t', 'A useful answer that stops early.');
          yield { type: 'reasoning-start', id: 'r' } as const;
          yield { type: 'reasoning-delta', id: 'r', delta: 'Partial reasoning.' } as const;
          yield {
            type: 'tool-input-available',
            toolCallId: 'tool-1',
            toolName: 'searchSources',
            input: { query: 'tides' },
          } as const;
          yield {
            type: 'source-url',
            sourceId: 'tool-1:0',
            url: 'https://example.com/source',
            title: 'Example source',
          } as const;
          yield {
            type: 'message-metadata',
            messageMetadata: { contextCompacted: true },
          } as WaldenUIMessageChunk;
          throw new Error(failure);
        })(),
      );
      const chunks = await requestTurn(db, {
        requestId: 'output-limit',
        conversationId: 'conversation',
        branchId: 'default',
        noteRevision: null,
        message: 'Give me a detailed answer.',
        personaId: 'thinking-partner',
      });
      expect(chunks.slice(-4)).toEqual([
        {
          type: 'data-turn',
          transient: true,
          data: expect.objectContaining({ branchId: 'default', failureCode: expectedCode }),
        },
        { type: 'message-metadata', messageMetadata: { status: 'interrupted' } },
        { type: 'error', errorText: expected },
        { type: 'finish', finishReason: 'error', messageMetadata: { status: 'interrupted' } },
      ]);

      const reloaded = await loadConversation(db, 'owner', 'conversation', { branchId: 'default' });
      const partial = reloaded.messages.at(-1)!;
      expect(partial).toMatchObject({
        role: 'assistant',
        metadata: {
          status: 'interrupted',
          contextCompacted: true,
          model: '@cf/zai-org/glm-5.3-flash',
        },
        parts: [
          { type: 'text', text: 'A useful answer that stops early.', state: 'done' },
          { type: 'reasoning', text: 'Partial reasoning.', state: 'done' },
          {
            type: 'tool-searchSources',
            toolCallId: 'tool-1',
            state: 'output-error',
            errorText: 'Stopped',
          },
          { type: 'source-url', url: 'https://example.com/source', title: 'Example source' },
        ],
      });
      expect(chunks[0]).toMatchObject({ type: 'start', messageId: partial.id });
    },
  );
});
