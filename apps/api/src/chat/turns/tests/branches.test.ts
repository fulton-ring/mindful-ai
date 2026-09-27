import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { readTurnEvents } from '../durable-store';
import { runChatTurn } from '../workflow-runner';

const mocks = vi.hoisted(() => ({ streamTurn: vi.fn() }));
vi.mock('../../../services/agent/agent', () => ({
  createAgentService: () => ({ streamTurn: mocks.streamTurn }),
  modelNameForPersona: () => 'test-model',
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
  await db.prepare("INSERT INTO users VALUES ('owner','subject','now','now',0)").run();
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
        "INSERT INTO messages (id,conversation_id,owner_id,role,content,created_at,parent_message_id,origin_branch_id) VALUES (?,'conversation','owner',?,?,'now',?,'default')",
      )
      .bind(id, role, content, parent)
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
  let execution: Promise<unknown> = Promise.resolve();
  const env = {
    DB: db,
    CHAT_WORKFLOW: {
      create: async ({ id }: { id: string }) => {
        const step = {
          do: (_name: string, optionsOrTask: unknown, task?: () => Promise<unknown>) =>
            (task ?? (optionsOrTask as () => Promise<unknown>))(),
        };
        execution = runChatTurn(env as Bindings, id, step as never);
        return { id };
      },
    },
  } as unknown as Bindings;
  const response = await app.fetch(
    new Request('https://walden.test/api/chat/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
    { waitUntil: () => undefined } as unknown as ExecutionContext,
  );
  if (!response.ok) return response.text();
  const { turnId } = (await response.json()) as { turnId: string };
  await execution;
  return (await readTurnEvents(db, turnId, 0))
    .map(({ event }) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function parseEvents(body: string) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line.replace(/^data: /, '')) as {
          type: string;
          message?: string;
          partialMessage?: {
            id: string;
            content: string;
            reasoning?: string;
            incomplete?: boolean;
            tools?: { id: string; name: string; state: string; summary: string }[];
            sources?: { url: string; title: string }[];
            contextCompacted?: boolean;
          };
        },
    );
}

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
    mocks.streamTurn.mockImplementation(
      async (input: { conversation: { id: string; branchId: string } }) =>
        (async function* () {
          yield {
            type: 'done',
            message: {
              id: 'replacement',
              role: 'assistant',
              content: 'Replacement answer',
              createdAt: '2026-09-18T17:00:00.000Z',
            },
            conversationId: input.conversation.id,
            branchId: input.conversation.branchId,
            title: 'Title',
            expiresAt: '2999-01-01',
          } as const;
        })(),
    );
    const body = await requestTurn(db, {
      requestId: 'regenerate',
      conversationId: 'conversation',
      branchId: 'default',
      noteRevision: null,
      message: 'ignored',
      personaId: 'thinking-partner',
      regenerateMessageId: 'a1',
    });
    expect(body).toContain('"type":"done"');
    const done = body
      .split('\n\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, '')))
      .find((event) => event.type === 'done');

    expect(done.branchId).not.toBe('default');
    expect(mocks.streamTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          branchId: done.branchId,
          messages: [],
        }),
      }),
      expect.objectContaining({ do: expect.any(Function) }),
      expect.any(AbortSignal),
    );
    expect(
      await db.prepare("SELECT content FROM messages WHERE id IN ('a1','a2') ORDER BY id").all(),
    ).toMatchObject({ results: [{ content: 'Original answer' }, { content: 'Later answer' }] });
    const branch = await loadConversation(db, 'owner', 'conversation', { branchId: done.branchId });
    expect(branch.messages.map(({ content }) => content)).toEqual(['First', 'Replacement answer']);
    const original = await loadConversation(db, 'owner', 'conversation', { branchId: 'default' });
    expect(original.messages.map(({ id }) => id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});

describe('conversation branches: editing', () => {
  beforeEach(() => vi.clearAllMocks());
  it('edits a prompt into a sibling branch without appending to the original path', async () => {
    const db = await fixture();
    mocks.streamTurn.mockImplementation(
      async (input: {
        conversation: { id: string; branchId: string; messages: { id: string }[] };
        message: string;
      }) => {
        expect(input.conversation.messages.map(({ id }) => id)).toEqual(['u1', 'a1']);
        expect(input.message).toBe('Edited prompt');
        return (async function* () {
          yield {
            type: 'done',
            message: {
              id: 'edited-answer',
              role: 'assistant',
              content: 'Edited answer',
              createdAt: '2026-09-18T17:00:00.000Z',
            },
            conversationId: input.conversation.id,
            branchId: input.conversation.branchId,
            title: 'Title',
            expiresAt: '2999-01-01',
          } as const;
        })();
      },
    );
    const body = await requestTurn(db, {
      requestId: 'edit-message',
      conversationId: 'conversation',
      branchId: 'default',
      noteRevision: null,
      message: 'Edited prompt',
      personaId: 'thinking-partner',
      editMessageId: 'u2',
    });
    const done = body
      .split('\n\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, '')))
      .find((event) => event.type === 'done');
    const edited = await loadConversation(db, 'owner', 'conversation', { branchId: done.branchId });
    expect(edited.messages.map(({ content }) => content)).toEqual([
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
    await db.prepare("UPDATE messages SET incomplete=1,content='' WHERE id='a2'").run();
    mocks.streamTurn.mockResolvedValue(
      (async function* () {
        yield {
          type: 'done',
          message: {
            id: 'retried-answer',
            role: 'assistant',
            content: 'Recovered answer',
            createdAt: '2026-09-18T17:00:00.000Z',
          },
          conversationId: 'conversation',
          branchId: 'default',
          title: 'Title',
          expiresAt: '2999-01-01',
        } as const;
      })(),
    );
    const body = await requestTurn(db, {
      requestId: 'retry-edited-message',
      conversationId: 'conversation',
      branchId: 'default',
      noteRevision: null,
      message: 'Repaired prompt',
      personaId: 'thinking-partner',
      editMessageId: 'u2',
    });
    expect(body).toContain('"branchId":"default"');
    const reloaded = await loadConversation(db, 'owner', 'conversation', { branchId: 'default' });
    expect(reloaded.messages.map(({ content }) => content)).toEqual([
      'First',
      'Original answer',
      'Repaired prompt',
      'Recovered answer',
    ]);
    expect(await db.prepare('SELECT count(*) AS count FROM conversation_branches').first()).toEqual(
      {
        count: 1,
      },
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
          yield { type: 'text', text: 'A useful answer that stops early.' } as const;
          yield { type: 'reasoning', text: 'Partial reasoning.' } as const;
          yield {
            type: 'tool',
            tool: { id: 'tool-1', name: 'searchSources', state: 'running', summary: 'Searching…' },
          } as const;
          yield {
            type: 'source',
            source: { url: 'https://example.com/source', title: 'Example source' },
          } as const;
          yield { type: 'context-compacted' } as const;
          throw new Error(failure);
        })(),
      );
      const events = parseEvents(
        await requestTurn(db, {
          requestId: 'output-limit',
          conversationId: 'conversation',
          branchId: 'default',
          noteRevision: null,
          message: 'Give me a detailed answer.',
          personaId: 'thinking-partner',
        }),
      );
      expect(events).toContainEqual({ type: 'text', text: 'A useful answer that stops early.' });
      const error = events.find(({ type }) => type === 'error');
      expect(error).toMatchObject({
        type: 'error',
        message: expected,
        code: expectedCode,
        partialMessage: {
          role: 'assistant',
          content: 'A useful answer that stops early.',
          reasoning: 'Partial reasoning.',
          incomplete: true,
          tools: [{ id: 'tool-1', name: 'searchSources', state: 'error', summary: 'Stopped' }],
          sources: [{ url: 'https://example.com/source', title: 'Example source' }],
          contextCompacted: true,
        },
      });
      expect(events.some(({ type }) => type === 'done')).toBe(false);

      const reloaded = await loadConversation(db, 'owner', 'conversation', { branchId: 'default' });
      expect(reloaded.messages.at(-1)).toMatchObject({
        id: error?.partialMessage?.id,
        role: 'assistant',
        content: 'A useful answer that stops early.',
        reasoning: 'Partial reasoning.',
        sources: [{ url: 'https://example.com/source', title: 'Example source' }],
        contextCompacted: true,
        incomplete: true,
        tools: [{ id: 'tool-1', name: 'searchSources', state: 'error', summary: 'Stopped' }],
      });
    },
  );
});
