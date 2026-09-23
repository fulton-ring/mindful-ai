import type { Conversation, Note } from '@walden/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';

const mocks = vi.hoisted(() => ({
  loadConversation: vi.fn(),
  loadNote: vi.fn(),
}));
vi.mock('../../conversations/conversations', () => ({ loadConversation: mocks.loadConversation }));
vi.mock('../../followups/followups', () => ({ loadNote: mocks.loadNote }));

import { capturePlacementRoutes } from '../capture-placement';

const note: Note = {
  id: 'note',
  title: 'Thread',
  markdown: '# Savings\nEmergency fund\n\n# Travel\nJapan',
  revision: 3,
  provenance: [],
  createdAt: 'now',
  updatedAt: 'now',
};
const conversation = {
  id: 'thread',
  noteId: 'note',
  title: 'Thread',
  messages: [],
  expiresAt: '2999-01-01',
  learningChecksEnabled: false,
  branchId: 'branch',
  branches: [],
} as Conversation;
const request = (body: object = { text: 'Keep three months of expenses.', noteRevision: 3 }) => {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    c.set('authSubject', 'subject');
    await next();
  });
  app.route('/api', capturePlacementRoutes);
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof HttpError ? error.status : 500),
  );
  return app.request(
    '/api/conversations/thread/capture-placement',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: {} as D1Database } as Bindings,
  );
};
describe('shared capture placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConversation.mockResolvedValue(conversation);
    mocks.loadNote.mockResolvedValue(note);
  });

  it('returns the captured text with no position at all', async () => {
    // Where it goes is not decided here and not stored anywhere: it is worked
    // out from the note wherever the edit is applied, so this can never hand
    // back a position that is already out of date.
    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      proposal: expect.objectContaining({
        oldText: '',
        newText: 'Keep three months of expenses.',
      }),
    });
  });

  it('rejects a stale starting revision before doing any work', async () => {
    const response = await request({ text: 'Keep three months of expenses.', noteRevision: 2 });

    expect(response.status).toBe(409);
  });

  it('treats already captured text as a no-op', async () => {
    const response = await request({ text: 'Emergency fund', noteRevision: 3 });

    expect(await response.json()).toEqual({ proposal: null });
  });

  it('declines text the note already states in other words', async () => {
    mocks.loadNote.mockResolvedValue({ ...note, markdown: 'Keep three months of expenses saved.' });
    const response = await request();

    expect(await response.json()).toEqual({ proposal: null });
  });

  it('captures into an empty note the same way as any other', async () => {
    mocks.loadNote.mockResolvedValue({ ...note, markdown: '' });
    const response = await request({ text: 'Exact captured text.', noteRevision: 3 });

    expect(await response.json()).toEqual({
      proposal: expect.objectContaining({ oldText: '', newText: 'Exact captured text.' }),
    });
  });
});
