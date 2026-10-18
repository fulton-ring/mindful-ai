import { Hono } from 'hono';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { conversationRoutes } from '../conversations';

export type ConversationRecord = {
  id: string;
  title?: string;
  ownerId: string;
  noteId: string | null;
  expiresAt: string;
  status: string;
};

type DatabaseOptions = {
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
};

type TestDatabase = D1Database & {
  conversations: ConversationRecord[];
  queries: string[];
};

function firstResult(
  sql: string,
  args: unknown[],
  options: DatabaseOptions,
  conversations: ConversationRecord[],
): unknown | null {
  if (sql.startsWith("UPDATE conversations SET status='purging'")) {
    const row = conversations.find(
      (item) => item.id === args[2] && item.ownerId === args[3] && item.status !== 'purging',
    );
    if (!row) return null;
    row.status = 'purging';
    return { id: row.id };
  }
  if (sql.includes('SELECT id FROM notes')) {
    return options.notes?.find(({ id, ownerId }) => id === args[0] && ownerId === args[1]) ?? null;
  }
  if (sql.includes("status='streaming'")) {
    return options.streamingConversationIds?.includes(args[0] as string) ? { id: 'turn' } : null;
  }
  if (sql.includes('FROM conversations')) {
    const row = conversations.find(({ id, ownerId }) => id === args[0] && ownerId === args[1]);
    return row
      ? {
          id: row.id,
          title: row.title ?? 'New conversation',
          note_id: row.noteId,
          expires_at: row.expiresAt,
          learning_consent: 0,
          status: row.status,
        }
      : null;
  }
  return null;
}

function allResults(
  sql: string,
  args: unknown[],
  options: DatabaseOptions,
  conversations: ConversationRecord[],
): unknown[] {
  if (sql.includes('FROM conversation_branches')) {
    return conversations
      .filter(({ ownerId }) => ownerId === args[1])
      .map((item) => ({
        id: `branch:${item.id}`,
        head_message_id: options.messages?.at(-1)?.id ?? null,
        forked_from_message_id: null,
        expires_at: item.expiresAt,
        status: item.status,
      }));
  }
  if (sql.includes('FROM conversations c')) return options.summaries ?? [];
  if (sql.includes('FROM messages')) return options.messages ?? [];
  if (sql.includes('FROM turns') && options.streamingConversationIds?.includes(args[0] as string)) {
    return [{ id: 'turn' }];
  }
  return [];
}

function applyRun(sql: string, args: unknown[], conversations: ConversationRecord[]) {
  if (sql.startsWith('INSERT INTO conversations')) {
    conversations.push({
      id: args[0] as string,
      title: args[4] as string,
      ownerId: args[1] as string,
      noteId: args[2] as string | null,
      expiresAt: args[6] as string,
      status: args[8] as string,
    });
    return;
  }
  if (sql.startsWith('UPDATE conversations SET note_id')) {
    const row = conversations.find(({ id, ownerId }) => id === args[1] && ownerId === args[2]);
    if (row) row.noteId = args[0] as string | null;
  } else if (sql.startsWith('UPDATE conversations SET title=')) {
    const row = conversations.find(({ id, ownerId }) => id === args[1] && ownerId === args[2]);
    if (row) row.title = args[0] as string;
  } else if (sql.includes("SET status='expired',purge_started_at")) {
    const row = conversations.find((item) => item.id === args[0] && item.ownerId === args[1]);
    if (row) row.status = 'expired';
  } else if (sql.includes("SET status='active',last_user_activity_at")) {
    const row = conversations.find(({ id, ownerId }) => id === args[3] && ownerId === args[4]);
    if (row) {
      row.status = 'active';
      row.expiresAt = args[1] as string;
    }
  } else if (sql.startsWith('DELETE FROM conversations')) {
    const index = conversations.findIndex(
      ({ id, ownerId }) => id === args[0] && ownerId === args[1],
    );
    if (index >= 0) conversations.splice(index, 1);
  }
}

export function database(options: DatabaseOptions = {}): TestDatabase {
  const conversations = options.conversations ?? [];
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
          return firstResult(sql, args, options, conversations) as T | null;
        },
        async all<T>() {
          return { results: allResults(sql, args, options, conversations) as T[] };
        },
        async run() {
          applyRun(sql, args, conversations);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as TestDatabase;
}

export function testApp(db: D1Database) {
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
