import { describe, expect, it } from 'vitest';
import { abortActiveTurn, registerActiveTurn } from '../turns/active-turns';
import { loadConversation } from './conversations';
import { type ConversationRecord, database, testApp } from './conversations.fixtures';

const conversation = (overrides: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: 'conversation',
  ownerId: 'owner',
  noteId: null,
  expiresAt: '2999-01-01T00:00:00.000Z',
  status: 'active',
  ...overrides,
});

describe('conversation listing and lifecycle', () => {
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
    expect(listQuery).toContain('n.title');
    expect(listQuery).toContain('c.title');
    expect(listQuery).toContain('LEFT JOIN notes n');
  });
});

describe('conversation deletion', () => {
  it('deletes an owned idle conversation', async () => {
    const db = database({ conversations: [conversation()] });
    const response = await testApp(db)('/api/conversations/conversation', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(db.conversations).toHaveLength(0);
  });

  it('archives an owned note-backed conversation without deleting its note', async () => {
    const db = database({
      notes: [{ id: 'note', ownerId: 'owner' }],
      conversations: [conversation({ noteId: 'note' })],
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
      conversations: [conversation({ noteId: 'note' })],
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
      conversations: [conversation({ ownerId: 'other' })],
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
        conversation({
          id: 'expired',
          noteId: 'preserved-note',
          expiresAt: '2020-01-01T00:00:00.000Z',
          status: 'expired',
        }),
      ],
    });
    const response = await testApp(db)('/api/conversations/expired', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(db.conversations).toHaveLength(0);
    expect(db.queries.some((query) => query.includes("SET status='active'"))).toBe(false);
  });
});

describe('conversation title and expiry behavior', () => {
  it('renames an owned conversation through the single title field', async () => {
    const db = database({ conversations: [conversation({ title: 'Old title' })] });
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
    const db = database({ conversations: [conversation({ ownerId: 'other', title: 'Private' })] });
    const response = await testApp(db)('/api/conversations/conversation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Stolen' }),
    });

    expect(response.status).toBe(404);
    expect(db.conversations[0]?.title).toBe('Private');
  });

  it('rejects conversation titles longer than 200 characters', async () => {
    const response = await testApp(database())('/api/conversations/conversation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201) }),
    });

    expect(response.status).toBe(400);
  });

  it('returns an expired note-linked conversation without its transcript', async () => {
    const db = database({
      conversations: [
        conversation({ noteId: 'note', expiresAt: '2020-01-01T00:00:00.000Z', status: 'expired' }),
      ],
    });
    const response = await testApp(db)('/api/conversations/conversation');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ noteId: 'note', messages: [] });
  });

  it('renews the original note-linked conversation with a fresh empty transcript', async () => {
    const db = database({
      conversations: [
        conversation({ noteId: 'note', expiresAt: '2020-01-01T00:00:00.000Z', status: 'expired' }),
      ],
    });
    const renewed = await loadConversation(db, 'owner', 'conversation', { renewExpired: true });

    expect(renewed.id).toBe('conversation');
    expect(renewed.noteId).toBe('note');
    expect(renewed.messages).toEqual([]);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
    expect(db.conversations[0]?.status).toBe('active');
  });
});
