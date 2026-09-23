import { describe, expect, it } from 'vitest';
import { loadConversation } from '../conversations';
import { database, testApp } from './conversations.fixtures';

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
      learningCheck: { id: 'check', questions: [{ id: 'location', format: 'multiple_choice' }] },
    });
    expect(loaded.messages[1]).toMatchObject({
      role: 'user',
      learningCheckResponse: { checkId: 'check', answers: { location: { answers: ['Stroma'] } } },
    });
  });
});

describe('conversation creation', () => {
  it('creates a conversation without creating or attaching a note', async () => {
    const db = database();
    const response = await testApp(db)('/api/conversations', { method: 'POST' });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ noteId: null, messages: [] });
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0]?.noteId).toBeNull();
  });

  it('attaches an owned note without changing the conversation transcript', async () => {
    const db = database({
      notes: [{ id: 'note', ownerId: 'owner' }],
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
});
