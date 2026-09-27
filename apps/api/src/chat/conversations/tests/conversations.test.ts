import type { WaldenUIMessage } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { loadConversation } from '../repository';
import { database, testApp } from './conversations.fixtures';

describe('conversation note attachment', () => {
  it('round-trips a stored assistant message with tool and source parts', async () => {
    const assistant: WaldenUIMessage = {
      id: 'assistant',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'tool-readWebPage',
          toolCallId: 'call',
          state: 'output-available',
          input: { query: 'https://example.com/' },
          output: { sources: [{ url: 'https://example.com/' }] },
        },
        { type: 'source-url', sourceId: 'source', url: 'https://example.com/' },
        { type: 'text', text: 'Answer', state: 'done' },
        {
          type: 'data-intervention',
          id: 'check',
          data: {
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
        },
      ],
      metadata: { createdAt: 'now', status: 'complete', contextCompacted: true },
    };
    const answer: WaldenUIMessage = {
      id: 'user-answer',
      role: 'user',
      parts: [
        { type: 'text', text: 'Stroma' },
        {
          type: 'data-learning-check-response',
          id: 'check',
          data: { checkId: 'check', answers: { location: { answers: ['Stroma'] } } },
        },
      ],
      metadata: { createdAt: 'later' },
    };
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
          ui_message: JSON.stringify(assistant),
          highlights_json: '[]',
          agent_highlights_json: '[]',
        },
        {
          id: 'user-answer',
          ui_message: JSON.stringify(answer),
          highlights_json: '[]',
          agent_highlights_json: '[]',
        },
      ],
    });
    const loaded = await loadConversation(db, 'owner', 'conversation');

    expect(loaded.messages).toEqual([assistant, answer]);
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
