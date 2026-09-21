import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';
import { abortActiveTurn, registerActiveTurn } from './active-turns';
import { conversationRoutes, loadConversation, purgeExpiredConversations } from './conversations';

type ConversationRecord = {
  id: string;
  title?: string;
  ownerId: string;
  noteId: string | null;
  expiresAt: string;
  status: string;
};

function database(
  options: {
    notes?: Array<{ id: string; ownerId: string }>;
    conversations?: ConversationRecord[];
    streamingConversationIds?: string[];
    summaries?: Array<{
      id: string;
      note_id: string | null;
      expires_at: string;
      title: string | null;
      last_user_activity_at: string;
      last_message_at?: string | null;
    }>;
    messages?: Array<Record<string, unknown>>;
  } = {},
) {
  const notes = options.notes ?? [];
  const conversations = options.conversations ?? [];
  const streaming = new Set(options.streamingConversationIds ?? []);
  const queries: string[] = [];
  return {
    conversations,
    queries,
    prepare(sql: string) {
      queries.push(sql);
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes('SELECT id FROM notes')) {
            const note = notes.find(({ id, ownerId }) => id === args[0] && ownerId === args[1]);
            return (note ? { id: note.id } : null) as T | null;
          }
          if (sql.includes("status='streaming'"))
            return (streaming.has(args[0] as string) ? { id: 'turn' } : null) as T | null;
          if (sql.includes('FROM conversations')) {
            const row = conversations.find(
              ({ id, ownerId }) => id === args[0] && ownerId === args[1],
            );
            return (
              row
                ? {
                    id: row.id,
                    title: row.title ?? 'New conversation',
                    note_id: row.noteId,
                    expires_at: row.expiresAt,
                    learning_consent: 0,
                    status: row.status,
                  }
                : null
            ) as T | null;
          }
          return null;
        },
        async all<T>() {
          return {
            results: (sql.includes('FROM conversation_branches')
              ? conversations
                  .filter(({ ownerId }) => ownerId === args[1])
                  .map((item) => ({
                    id: `branch:${item.id}`,
                    head_message_id: options.messages?.at(-1)?.id ?? null,
                    forked_from_message_id: null,
                    expires_at: item.expiresAt,
                    status: item.status,
                  }))
              : sql.includes('FROM conversations c')
                ? (options.summaries ?? [])
                : sql.includes('FROM messages')
                  ? (options.messages ?? [])
                  : sql.includes('FROM turns') && streaming.has(args[0] as string)
                    ? [{ id: 'turn' }]
                    : []) as T[],
          };
        },
        async run() {
          if (sql.startsWith('INSERT INTO conversations')) {
            conversations.push({
              id: args[0] as string,
              title: args[4] as string,
              ownerId: args[1] as string,
              noteId: args[2] as string | null,
              expiresAt: args[7] as string,
              status: args[8] as string,
            });
          }
          if (sql.startsWith('UPDATE conversations SET note_id')) {
            const row = conversations.find(
              ({ id, ownerId }) => id === args[1] && ownerId === args[2],
            );
            if (row) row.noteId = args[0] as string | null;
          }
          if (sql.startsWith('UPDATE conversations SET title=')) {
            const row = conversations.find(
              ({ id, ownerId }) => id === args[1] && ownerId === args[2],
            );
            if (row) row.title = args[0] as string;
          }
          if (sql.includes("SET status='active',last_user_activity_at")) {
            const row = conversations.find(
              ({ id, ownerId }) => id === args[2] && ownerId === args[3],
            );
            if (row) {
              row.status = 'active';
              row.expiresAt = args[1] as string;
            }
          }
          if (sql.startsWith('DELETE FROM conversations')) {
            const index = conversations.findIndex(
              ({ id, ownerId }) => id === args[0] && ownerId === args[1],
            );
            if (index >= 0) conversations.splice(index, 1);
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database & { conversations: ConversationRecord[]; queries: string[] };
}

function testApp(db: D1Database) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api', conversationRoutes);
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ error: error.message }, error.status) : c.json({}, 500),
  );
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://walden.test${path}`, init), { DB: db });
}

describe('conversation note attachment', () => {
  it('reconstructs persisted tool activity and sources', async () => {
    const db = database({
      conversations: [
        {
          id: 'conversation',
          ownerId: 'owner',
          noteId: null,
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
      messages: [
        {
          id: 'assistant',
          role: 'assistant',
          content: 'Answer',
          reasoning: null,
          created_at: 'now',
          annotations_json: '[]',
          activity_json: JSON.stringify({
            tools: [{ id: 'call', name: 'readWebPage', state: 'complete', summary: 'Source read' }],
            sources: [{ id: 'source', url: 'https://example.com/' }],
            contextCompacted: true,
            learningCheck: {
              id: 'check',
              kind: 'learning_check',
              questions: [
                {
                  id: 'location',
                  header: 'Location',
                  format: 'multiple_choice',
                  question: 'Where does the Calvin cycle occur?',
                  options: ['Stroma', 'Thylakoid'],
                },
              ],
            },
          }),
          incomplete: 0,
        },
        {
          id: 'user-answer',
          role: 'user',
          content: 'Stroma',
          reasoning: null,
          created_at: 'later',
          annotations_json: '[]',
          activity_json: JSON.stringify({
            learningCheckResponse: {
              checkId: 'check',
              answers: { location: { answers: ['Stroma'] } },
            },
          }),
          incomplete: 0,
        },
      ],
    });

    const loaded = await loadConversation(db, 'owner', 'conversation');

    expect(loaded.messages[0]).toMatchObject({
      tools: [{ id: 'call', state: 'complete' }],
      sources: [{ id: 'source', url: 'https://example.com/' }],
      contextCompacted: true,
      learningCheck: {
        id: 'check',
        questions: [{ id: 'location', format: 'multiple_choice' }],
      },
    });
    expect(loaded.messages[1]).toMatchObject({
      role: 'user',
      learningCheckResponse: {
        checkId: 'check',
        answers: { location: { answers: ['Stroma'] } },
      },
    });
  });

  it('creates a conversation without creating or attaching a note', async () => {
    const db = database();
    const response = await testApp(db)('/api/conversations', { method: 'POST' });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ noteId: null, messages: [] });
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0]?.noteId).toBeNull();
  });

  it('attaches an owned note without changing the conversation transcript', async () => {
    const conversation: ConversationRecord = {
      id: 'conversation',
      ownerId: 'owner',
      noteId: null,
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'active',
    };
    const db = database({
      notes: [{ id: 'note', ownerId: 'owner' }],
      conversations: [conversation],
    });
    const response = await testApp(db)('/api/conversations/conversation/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteId: 'note' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'conversation',
      noteId: 'note',
      messages: [],
    });
  });

  it('rejects attachment changes while a turn is streaming', async () => {
    const db = database({
      conversations: [
        {
          id: 'conversation',
          ownerId: 'owner',
          noteId: null,
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
      streamingConversationIds: ['conversation'],
    });
    const response = await testApp(db)('/api/conversations/conversation/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteId: null }),
    });

    expect(response.status).toBe(409);
  });

  it('lists active conversation summaries with a fallback title', async () => {
    const db = database({
      summaries: [
        {
          id: 'conversation',
          note_id: null,
          expires_at: '2999-01-01T00:00:00.000Z',
          title: 'New conversation',
          last_user_activity_at: '2026-01-02T00:00:00.000Z',
          last_message_at: '2026-01-02T00:02:00.000Z',
        },
      ],
    });
    const response = await testApp(db)('/api/conversations');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: 'conversation',
        noteId: null,
        expiresAt: '2999-01-01T00:00:00.000Z',
        title: 'New conversation',
        updatedAt: '2026-01-02T00:00:00.000Z',
        lastMessageAt: '2026-01-02T00:02:00.000Z',
        noteUpdatedAt: null,
      },
    ]);
    const listQuery = db.queries.find((query) => query.includes('FROM conversations c')) ?? '';
    // The note owns its name, so a note-backed thread is listed under the
    // note's title and falls back to its own only when unattached or untitled.
    expect(listQuery).toContain('n.title');
    expect(listQuery).toContain('c.title');
    expect(listQuery).toContain('LEFT JOIN notes n');
  });

  it('deletes an owned idle conversation', async () => {
    const db = database({
      conversations: [
        {
          id: 'conversation',
          ownerId: 'owner',
          noteId: null,
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
    });
    const response = await testApp(db)('/api/conversations/conversation', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(db.conversations).toHaveLength(0);
  });

  it('archives an owned note-backed conversation without deleting its note', async () => {
    const db = database({
      notes: [{ id: 'note', ownerId: 'owner' }],
      conversations: [
        {
          id: 'conversation',
          ownerId: 'owner',
          noteId: 'note',
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
    });

    const response = await testApp(db)('/api/conversations/conversation?keepNote=1', {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
    expect(db.conversations).toHaveLength(0);
    expect(db.queries.some((query) => query.startsWith('DELETE FROM notes'))).toBe(false);
  });

  it('deletes an owned streaming conversation and aborts its local turn', async () => {
    const controller = new AbortController();
    registerActiveTurn('turn', 'conversation', controller);
    const db = database({
      conversations: [
        {
          id: 'conversation',
          ownerId: 'owner',
          noteId: 'note',
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
      streamingConversationIds: ['conversation'],
    });

    const response = await testApp(db)('/api/conversations/conversation', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(controller.signal.aborted).toBe(true);
    expect(db.conversations).toHaveLength(0);
    expect(db.queries.some((query) => query.startsWith('DELETE FROM notes'))).toBe(true);
  });

  it("does not abort or delete another owner's streaming conversation", async () => {
    const controller = new AbortController();
    registerActiveTurn('turn', 'conversation', controller);
    const db = database({
      conversations: [
        {
          id: 'conversation',
          ownerId: 'other',
          noteId: null,
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
      streamingConversationIds: ['conversation'],
    });

    const response = await testApp(db)('/api/conversations/conversation', { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(controller.signal.aborted).toBe(false);
    expect(db.conversations).toHaveLength(1);
    abortActiveTurn('turn', 'test cleanup');
  });

  it('deletes an owned expired conversation without attempting renewal', async () => {
    const db = database({
      conversations: [
        {
          id: 'expired',
          ownerId: 'owner',
          noteId: 'preserved-note',
          expiresAt: '2020-01-01T00:00:00.000Z',
          status: 'expired',
        },
      ],
    });

    const response = await testApp(db)('/api/conversations/expired', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(db.conversations).toHaveLength(0);
    expect(db.queries.some((query) => query.includes("SET status='active'"))).toBe(false);
  });

  it('renames an owned conversation through the single title field', async () => {
    const db = database({
      conversations: [
        {
          id: 'conversation',
          title: 'Old title',
          ownerId: 'owner',
          noteId: null,
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
    });
    const response = await testApp(db)('/api/conversations/conversation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed thought' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'conversation', title: 'Renamed thought' });
    expect(db.conversations[0]?.title).toBe('Renamed thought');
  });

  it("does not rename another owner's conversation", async () => {
    const db = database({
      conversations: [
        {
          id: 'conversation',
          title: 'Private',
          ownerId: 'other',
          noteId: null,
          expiresAt: '2999-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
    });
    const response = await testApp(db)('/api/conversations/conversation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Stolen' }),
    });
    expect(response.status).toBe(404);
    expect(db.conversations[0]?.title).toBe('Private');
  });

  it('rejects conversation titles longer than 200 characters', async () => {
    const db = database();
    const response = await testApp(db)('/api/conversations/conversation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201) }),
    });
    expect(response.status).toBe(400);
  });

  it('returns an expired note-linked conversation without its transcript', async () => {
    const db = database({
      conversations: [
        {
          id: 'conversation',
          ownerId: 'owner',
          noteId: 'note',
          expiresAt: '2020-01-01T00:00:00.000Z',
          status: 'expired',
        },
      ],
    });
    const response = await testApp(db)('/api/conversations/conversation');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ noteId: 'note', messages: [] });
  });
});

describe('expired conversation cleanup', () => {
  it('purges transcript and native memory on access even when no note exists', async () => {
    const db = database({
      conversations: [
        {
          id: 'expired-empty',
          ownerId: 'owner',
          noteId: null,
          expiresAt: '2020-01-01T00:00:00.000Z',
          status: 'expired',
        },
      ],
    });
    await expect(loadConversation(db, 'owner', 'expired-empty')).rejects.toThrow(
      'Conversation expired',
    );
    expect(db.queries.some((sql) => sql.startsWith('DELETE FROM messages'))).toBe(true);
    expect(
      db.queries.some((sql) => sql.includes('DELETE FROM "agent_mastra_observational_memory"')),
    ).toBe(true);
  });

  it('renews the original note-linked conversation with a fresh empty transcript', async () => {
    const db = database({
      conversations: [
        {
          id: 'conversation',
          ownerId: 'owner',
          noteId: 'note',
          expiresAt: '2020-01-01T00:00:00.000Z',
          status: 'expired',
        },
      ],
    });

    const renewed = await loadConversation(db, 'owner', 'conversation', { renewExpired: true });

    expect(renewed.id).toBe('conversation');
    expect(renewed.noteId).toBe('note');
    expect(renewed.messages).toEqual([]);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
    expect(db.conversations[0]?.status).toBe('active');
  });

  it('purges child state, preserves note-linked rows, and deletes unattached rows', async () => {
    const sql: string[] = [];
    const db = {
      prepare(query: string) {
        sql.push(query);
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database;

    await purgeExpiredConversations(db);

    expect(sql.some((query) => query.startsWith('DELETE FROM messages'))).toBe(true);
    expect(sql.some((query) => query.startsWith('DELETE FROM turns'))).toBe(true);
    expect(sql.some((query) => query.startsWith('DELETE FROM interventions'))).toBe(true);
    expect(
      sql.some(
        (query) =>
          query.startsWith('UPDATE conversations') && query.includes('note_id IS NOT NULL'),
      ),
    ).toBe(true);
    expect(
      sql.some(
        (query) =>
          query.startsWith('DELETE FROM conversations') && query.includes('note_id IS NULL'),
      ),
    ).toBe(true);
  });
});
