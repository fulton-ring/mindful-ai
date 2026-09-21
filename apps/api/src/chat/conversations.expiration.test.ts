import { describe, expect, it } from 'vitest';
import { loadConversation, purgeExpiredConversations } from './conversations';
import { database } from './conversations.fixtures';

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
