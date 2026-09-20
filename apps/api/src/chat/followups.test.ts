import type { Conversation, EditProposal } from '@walden/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';

const mocks = vi.hoisted(() => ({
  annotateTurn: vi.fn(),
  streamAnnotations: vi.fn(),
  streamNoteProposal: vi.fn(),
  createAgentService: vi.fn(),
  loadConversation: vi.fn(),
  personaFor: vi.fn(),
  loadNoteSuggestionBatch: vi.fn(),
  loadNoteSuggestionBySource: vi.fn(),
  loadPendingNoteSuggestions: vi.fn(async () => []),
  persistNoteSuggestion: vi.fn(),
  cancelNoteSuggestionAttempt: vi.fn(),
  loadNoteState: vi.fn(),
}));

vi.mock('../services/agent', () => ({
  createAgentService: mocks.createAgentService,
}));
vi.mock('../http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../http')>()),
  newId: () => 'proposal-attempt',
}));
vi.mock('./conversations', () => ({
  loadConversation: mocks.loadConversation,
}));
vi.mock('./routes', () => ({
  personaFor: mocks.personaFor,
}));
vi.mock('../notes/suggestions', () => ({
  cancelNoteSuggestionAttempt: mocks.cancelNoteSuggestionAttempt,
  loadNoteSuggestionBatch: mocks.loadNoteSuggestionBatch,
  loadNoteSuggestionBySource: mocks.loadNoteSuggestionBySource,
  loadPendingNoteSuggestions: mocks.loadPendingNoteSuggestions,
  persistNoteSuggestion: mocks.persistNoteSuggestion,
}));
vi.mock('../notes/history', () => ({ loadNoteState: mocks.loadNoteState }));

import { followupRoutes } from './followups';

const userMessage = {
  id: 'user-message',
  role: 'user' as const,
  content: 'Capture the deployment decision.',
  createdAt: '2026-09-18T12:00:00.000Z',
};
const assistantMessage = {
  id: 'assistant-message',
  role: 'assistant' as const,
  content: 'Use the smaller deployment for the first release.',
  createdAt: '2026-09-18T12:00:01.000Z',
};

function conversation(
  messages: Conversation['messages'] = [userMessage, assistantMessage],
): Conversation {
  return {
    id: 'conversation',
    title: 'Deployment',
    noteId: 'note',
    messages,
    expiresAt: '2999-01-01T00:00:00.000Z',
    learningChecksEnabled: false,
    branchId: 'branch',
    branches: [],
  };
}

function database(noteRevision = 3, latestNote?: { markdown: string; revision: number }) {
  let noteReads = 0;
  const updates: unknown[][] = [];
  const deletedSuggestions: unknown[][] = [];
  return {
    updates,
    deletedSuggestions,
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes('FROM notes')) {
            noteReads++;
            return {
              id: 'note',
              markdown: noteReads > 1 && latestNote ? latestNote.markdown : 'Deployment notes.',
              revision: noteReads > 1 && latestNote ? latestNote.revision : noteRevision,
              provenance_json: '[]',
              created_at: '2026-09-18T11:00:00.000Z',
              updated_at: '2026-09-18T11:00:00.000Z',
            } as T;
          }
          if (sql.includes('SELECT turn_id FROM messages')) return { turn_id: 'turn' } as T;
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO message_highlights')) updates.push(args);
          if (sql.includes('DELETE FROM note_suggestions')) deletedSuggestions.push(args);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database & { updates: unknown[][]; deletedSuggestions: unknown[][] };
}

function testApp(db: D1Database) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    c.set('authSubject', 'subject');
    await next();
  });
  app.route('/api/chat', followupRoutes);
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ error: error.message }, error.status) : c.json({}, 500),
  );
  return async (
    operation: 'annotations' | 'note-proposal',
    noteRevision: number | null = 3,
    stream = false,
    noteProposalRequested?: boolean,
    extraRequest: Record<string, unknown> = {},
  ) => {
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(
        `https://walden.test/api/chat/messages/assistant-message/${operation}${stream ? '?stream=1' : ''}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: 'conversation',
            branchId: 'branch',
            personaId: '',
            noteRevision,
            noteProposalRequested,
            ...extraRequest,
          }),
        },
      ),
      { DB: db } as Bindings,
      { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext,
    );
    return { response, pending };
  };
}

function events(body: string) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line.replace(/^data: /, '')));
}

const proposal: EditProposal = {
  id: 'proposal',
  noteId: 'note',
  baseRevision: 3,
  oldText: 'Deployment notes.',
  newText: 'Use the smaller deployment for the first release.',
  reason: 'Captures the deployment decision.',
  status: 'pending',
};
const attemptedProposal = { ...proposal, id: 'proposal-attempt' };

describe('message follow-ups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentService.mockReturnValue({
      annotateTurn: mocks.annotateTurn,
      streamAnnotations: mocks.streamAnnotations,
      streamNoteProposal: mocks.streamNoteProposal,
    });
    mocks.personaFor.mockResolvedValue({
      id: 'default',
      name: 'Default',
      prompt: '',
      tone: 'neutral',
      brevity: 'balanced',
      challenge: 'balanced',
      revision: 1,
    });
    mocks.loadNoteSuggestionBySource.mockResolvedValue(null);
    mocks.loadNoteSuggestionBatch.mockResolvedValue([]);
    mocks.persistNoteSuggestion.mockImplementation(async (_db, input) => ({
      noteId: input.proposal.noteId,
      suggestion: input.proposal,
      created: true,
    }));
    mocks.cancelNoteSuggestionAttempt.mockResolvedValue({
      noteId: null,
      cancelledSuggestionIds: [],
    });
    mocks.loadNoteState.mockResolvedValue(null);
  });

  it('durably cancels only the exact note proposal attempt', async () => {
    mocks.cancelNoteSuggestionAttempt.mockResolvedValue({
      noteId: 'note',
      cancelledSuggestionIds: ['attempt-new', 'attempt-new:1'],
    });
    mocks.loadNoteState.mockResolvedValue({ note: { id: 'note' }, suggestions: [] });
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('userId', 'owner');
      c.set('authSubject', 'subject');
      await next();
    });
    app.route('/api/chat', followupRoutes);

    const response = await app.fetch(
      new Request('https://walden.test/api/chat/messages/assistant-message/note-proposal/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conversation',
          branchId: 'branch',
          attemptId: 'attempt-new',
        }),
      }),
      { DB: database() } as Bindings,
    );

    expect(response.status).toBe(200);
    expect(mocks.cancelNoteSuggestionAttempt).toHaveBeenCalledWith(expect.anything(), {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'assistant-message',
      attemptId: 'attempt-new',
    });
    await expect(response.json()).resolves.toMatchObject({
      cancelledSuggestionIds: ['attempt-new', 'attempt-new:1'],
      noteState: { note: { id: 'note' }, suggestions: [] },
    });
  });

  it('rejects an unowned conversation without calling a model', async () => {
    mocks.loadConversation.mockRejectedValue(new HttpError(404, 'Conversation not found'));

    const { response } = await testApp(database())('annotations');

    expect(response.status).toBe(404);
    expect(mocks.createAgentService).not.toHaveBeenCalled();
    expect(mocks.annotateTurn).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', [userMessage]],
    ['incomplete', [userMessage, { ...assistantMessage, incomplete: true }]],
  ])('rejects a %s assistant response without calling a model', async (_label, messages) => {
    mocks.loadConversation.mockResolvedValue(conversation(messages));

    const { response } = await testApp(database())('annotations');

    expect(response.status).toBe(404);
    expect(mocks.createAgentService).not.toHaveBeenCalled();
    expect(mocks.annotateTurn).not.toHaveBeenCalled();
  });

  it('rejects a stale note revision before calling the proposal model', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());

    const { response } = await testApp(database())('note-proposal', 2);

    expect(response.status).toBe(409);
    expect(mocks.streamNoteProposal).not.toHaveBeenCalled();
  });

  it('generates a proposal from an older completed response using the current note', async () => {
    const laterUser = { ...userMessage, id: 'later-user', content: 'A later question.' };
    const laterAssistant = {
      ...assistantMessage,
      id: 'later-assistant',
      content: 'A later answer.',
    };
    const history = conversation([userMessage, assistantMessage, laterUser, laterAssistant]);
    mocks.loadConversation.mockResolvedValue(history);
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'done', proposal } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toEqual([{ type: 'done', proposal: attemptedProposal }]);
    expect(mocks.streamNoteProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        message: userMessage.content,
        conversation: expect.objectContaining({ messages: [] }),
        note: expect.objectContaining({ revision: 3 }),
      }),
      assistantMessage,
      expect.any(AbortSignal),
    );
    expect(mocks.persistNoteSuggestion.mock.calls[0][1]).toMatchObject({
      sourceMessageId: assistantMessage.id,
      expectedRevision: 3,
    });
  });

  it('streams an explicit capture through the shared proposal service', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'done', proposal } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal', 3, true, true, {
      action: 'capture',
      captureText: 'Exact selected answer text.',
    });
    await response.text();
    await Promise.all(pending);

    expect(mocks.streamNoteProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'capture',
        message: 'Exact selected answer text.',
        noteProposalRequested: true,
      }),
      assistantMessage,
      expect.any(AbortSignal),
    );
  });

  it('uses a distinct replay key for each selected passage from the same response', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.loadNoteSuggestionBySource.mockResolvedValue(null);
    mocks.streamNoteProposal.mockImplementation(async () =>
      (async function* () {
        yield { type: 'done', proposal } as const;
      })(),
    );

    const first = await testApp(database())('note-proposal', 3, true, true, {
      action: 'capture',
      captureText: 'Exact selected answer text.',
    });
    await first.response.text();
    await Promise.all(first.pending);
    const second = await testApp(database())('note-proposal', 3, true, true, {
      action: 'capture',
      captureText: 'A different selected passage.',
    });
    await second.response.text();
    await Promise.all(second.pending);

    const firstKey = mocks.loadNoteSuggestionBySource.mock.calls[0][1].generationKey;
    const secondKey = mocks.loadNoteSuggestionBySource.mock.calls[1][1].generationKey;
    expect(firstKey).toMatch(/^assistant-message:capture:[0-9a-f]{64}$/);
    expect(secondKey).toMatch(/^assistant-message:capture:[0-9a-f]{64}$/);
    expect(firstKey).not.toBe(secondKey);
    expect(mocks.streamNoteProposal).toHaveBeenCalledTimes(2);
  });

  it('rejects capture requests without selected text', async () => {
    const { response } = await testApp(database())('note-proposal', 3, true, true, {
      action: 'capture',
    });

    expect(response.status).toBe(400);
    expect(mocks.streamNoteProposal).not.toHaveBeenCalled();
  });

  it('persists annotations on the owned completed assistant message', async () => {
    const db = database();
    const annotations = [
      { id: 'annotation', quote: 'smaller deployment', kind: 'decision', whose: 'assistant' },
    ];
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.annotateTurn.mockResolvedValue(annotations);

    const { response } = await testApp(db)('annotations');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ annotations });
    expect(mocks.annotateTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn', message: userMessage.content }),
      assistantMessage,
      expect.any(AbortSignal),
    );
    // One agent highlight row per annotation, anchored on the assistant message.
    expect(db.updates.map((row) => [row[0], row[1], row[4]])).toEqual(
      annotations.map((item) => [assistantMessage.id, 'owner', item.quote]),
    );
  });

  it('returns a retryable error without overwriting highlights when the classifier fails', async () => {
    const db = database();
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.annotateTurn.mockRejectedValue(new Error('upstream diagnostic must stay private'));

    const { response } = await testApp(db)('annotations');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Highlights could not be generated. Please try again.',
    });
    expect(db.updates).toEqual([]);
  });

  it('streams a validated annotation before the final set and persists only the final set', async () => {
    const db = database();
    const annotation = {
      id: 'annotation',
      quote: 'smaller deployment',
      kind: 'decision' as const,
      whose: 'assistant' as const,
    };
    let finish!: () => void;
    const finalReady = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamAnnotations.mockResolvedValue(
      (async function* () {
        yield { type: 'annotation', annotation } as const;
        await finalReady;
        yield { type: 'done', annotations: [annotation] } as const;
      })(),
    );

    const { response, pending } = await testApp(db)('annotations', 3, true);
    const reader = response.body?.getReader();
    const firstChunk = await reader?.read();

    expect(new TextDecoder().decode(firstChunk?.value)).toContain(
      JSON.stringify({ type: 'annotation', annotation }),
    );
    expect(db.updates).toEqual([]);
    finish();
    let remainder = '';
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += new TextDecoder().decode(chunk.value);
    }
    await Promise.all(pending);
    expect(remainder).toContain(JSON.stringify({ type: 'done', annotations: [annotation] }));
    expect(db.updates.map((row) => row[4])).toEqual([annotation.quote]);
  });

  it('streams classifier errors without persisting provisional annotations', async () => {
    const db = database();
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamAnnotations.mockResolvedValue(
      (async function* () {
        yield {
          type: 'error',
          message: 'Highlights could not be generated. Please try again.',
        } as const;
      })(),
    );

    const { response, pending } = await testApp(db)('annotations', 3, true);
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toEqual([
      { type: 'error', message: 'Highlights could not be generated. Please try again.' },
    ]);
    expect(db.updates).toEqual([]);
  });

  it('preserves existing annotations and filters overlapping additions before streaming', async () => {
    const existing = {
      id: 'existing',
      quote: 'smaller deployment',
      kind: 'decision' as const,
      whose: 'assistant' as const,
    };
    const overlapping = {
      id: 'overlapping',
      quote: 'Use the smaller deployment',
      kind: 'decision' as const,
      whose: 'assistant' as const,
    };
    const addition = {
      id: 'addition',
      quote: 'first release',
      kind: 'fact' as const,
      whose: 'assistant' as const,
    };
    mocks.loadConversation.mockResolvedValue(
      conversation([userMessage, { ...assistantMessage, annotations: [existing] }]),
    );
    mocks.streamAnnotations.mockResolvedValue(
      (async function* () {
        yield { type: 'annotation', annotation: overlapping } as const;
        yield { type: 'annotation', annotation: addition } as const;
        yield { type: 'done', annotations: [overlapping, addition] } as const;
      })(),
    );
    const db = database();

    const { response, pending } = await testApp(db)('annotations', 3, true);
    const streamed = events(await response.text());
    await Promise.all(pending);

    expect(streamed).toEqual([
      { type: 'annotation', annotation: addition },
      { type: 'done', annotations: [existing, addition] },
    ]);
    expect(db.updates.map((row) => row[4])).toEqual([existing.quote, addition.quote]);
  });

  it('returns four existing annotations without another model call', async () => {
    const annotations = Array.from({ length: 4 }, (_, index) => ({
      id: `existing-${index}`,
      quote: `quote-${index}`,
      kind: 'claim' as const,
      whose: 'assistant' as const,
    }));
    mocks.loadConversation.mockResolvedValue(
      conversation([userMessage, { ...assistantMessage, annotations }]),
    );

    const { response } = await testApp(database())('annotations', 3, true);

    expect(events(await response.text())).toEqual([{ type: 'done', annotations }]);
    expect(mocks.createAgentService).not.toHaveBeenCalled();
  });

  it('streams provisional previews followed by the final proposal', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(events(body)).toEqual([
      { type: 'preview', proposal: attemptedProposal },
      { type: 'done', proposal: attemptedProposal },
    ]);
    expect(mocks.persistNoteSuggestion).toHaveBeenCalledTimes(1);
    expect(mocks.persistNoteSuggestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerId: 'owner',
        conversationId: 'conversation',
        sourceMessageId: assistantMessage.id,
        expectedNoteId: 'note',
        expectedRevision: 3,
        proposal: attemptedProposal,
      }),
    );
  });

  it('persists an ordered operation batch under independent generation keys', async () => {
    const second = {
      ...proposal,
      id: 'second-model-id',
      newText: 'Keep rollback available for the first release.',
      reason: 'Captures the rollback constraint.',
    };
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal, operationIndex: 0 } as const;
        yield { type: 'preview', proposal: second, operationIndex: 1 } as const;
        yield { type: 'done', proposal: second, proposals: [proposal, second] } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toMatchObject([
      { type: 'preview', operationIndex: 0, proposal: { id: 'proposal-attempt' } },
      { type: 'preview', operationIndex: 1, proposal: { id: 'proposal-attempt:1' } },
      {
        type: 'done',
        proposal: expect.objectContaining({ id: 'proposal-attempt:1' }),
        proposals: [{ id: 'proposal-attempt' }, { id: 'proposal-attempt:1' }],
      },
    ]);
    expect(mocks.persistNoteSuggestion).toHaveBeenCalledTimes(2);
    expect(mocks.persistNoteSuggestion.mock.calls[0][1]).toMatchObject({
      generationKey: assistantMessage.id,
    });
    expect(mocks.persistNoteSuggestion.mock.calls[1][1]).toMatchObject({
      generationKey: `${assistantMessage.id}:operation:1`,
    });
  });

  it('keeps a surviving later operation identity after the first operation declines', async () => {
    const second = {
      ...proposal,
      id: 'second-model-id',
      newText: 'Keep rollback available for the first release.',
    };
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal, operationIndex: 0 } as const;
        yield { type: 'preview', proposal: second, operationIndex: 1 } as const;
        yield { type: 'done', proposal: second, proposals: [second] } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toMatchObject([
      { type: 'preview', proposal: { id: 'proposal-attempt' } },
      { type: 'preview', proposal: { id: 'proposal-attempt:1' } },
      {
        type: 'done',
        proposal: { id: 'proposal-attempt:1' },
        proposals: [{ id: 'proposal-attempt:1' }],
      },
    ]);
    expect(mocks.persistNoteSuggestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        generationKey: `${assistantMessage.id}:operation:1`,
        proposal: expect.objectContaining({ id: 'proposal-attempt:1' }),
      }),
    );
  });

  it('allocates a final-only operation without colliding with a preview slot', async () => {
    const finalOnly = { ...proposal, id: 'final-only', newText: 'A final-only operation.' };
    const surviving = { ...proposal, id: 'surviving', newText: 'The preview survives.' };
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal: surviving, operationIndex: 1 } as const;
        yield { type: 'done', proposal: surviving, proposals: [finalOnly, surviving] } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toMatchObject([
      { type: 'preview', proposal: { id: 'proposal-attempt:1' } },
      {
        type: 'done',
        proposals: [{ id: 'proposal-attempt' }, { id: 'proposal-attempt:1' }],
      },
    ]);
    expect(
      new Set(mocks.persistNoteSuggestion.mock.calls.map((call) => call[1].proposal.id)),
    ).toEqual(new Set(['proposal-attempt', 'proposal-attempt:1']));
  });

  it('uses the lazily created note baseline for later operations in a first-note batch', async () => {
    const emptyConversation = { ...conversation(), noteId: null };
    const first = {
      ...proposal,
      noteId: 'unsaved-note',
      baseRevision: 0,
      oldText: '',
      newText: 'One.',
    };
    const second = { ...first, id: 'second', newText: 'Two.' };
    mocks.loadConversation.mockResolvedValue(emptyConversation);
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'done', proposal: second, proposals: [first, second] } as const;
      })(),
    );
    mocks.persistNoteSuggestion.mockImplementation(async (_db, persistence) => ({
      noteId: 'created-note',
      suggestion: { ...persistence.proposal, noteId: 'created-note' },
      created: true,
    }));

    const { response, pending } = await testApp(database())('note-proposal', null);
    await response.text();
    await Promise.all(pending);

    expect(mocks.persistNoteSuggestion.mock.calls[0][1]).toMatchObject({
      expectedNoteId: null,
      expectedRevision: null,
      generationKey: assistantMessage.id,
      proposal: { id: 'proposal-attempt', newText: 'One.' },
    });
    expect(mocks.persistNoteSuggestion.mock.calls[1][1]).toMatchObject({
      expectedNoteId: 'created-note',
      expectedRevision: 0,
      generationKey: `${assistantMessage.id}:operation:1`,
      proposal: {
        id: 'proposal-attempt:1',
        noteId: 'created-note',
        baseRevision: 0,
        newText: 'Two.',
      },
    });
  });

  it('removes only its pending suggestion when cancellation races persistence', async () => {
    const db = database();
    let finishPersistence!: (value: {
      noteId: string;
      suggestion: typeof proposal;
      created: boolean;
    }) => void;
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal } as const;
      })(),
    );
    mocks.persistNoteSuggestion.mockReturnValue(
      new Promise((resolve) => {
        finishPersistence = resolve;
      }),
    );

    const { response, pending } = await testApp(db)('note-proposal');
    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(mocks.persistNoteSuggestion).toHaveBeenCalledTimes(1));
    await reader.cancel();
    finishPersistence({ noteId: 'note', suggestion: proposal, created: true });
    await Promise.all(pending);

    expect(db.deletedSuggestions).toEqual([
      [proposal.id, 'owner', 'conversation', assistantMessage.id],
    ]);
  });

  it('removes its newly persisted suggestion when the final event cannot be delivered', async () => {
    const db = database();
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal } as const;
      })(),
    );
    const enqueue = ReadableStreamDefaultController.prototype.enqueue;
    let calls = 0;
    const enqueueSpy = vi
      .spyOn(ReadableStreamDefaultController.prototype, 'enqueue')
      .mockImplementation(function (
        this: ReadableStreamDefaultController<Uint8Array>,
        chunk: Uint8Array,
      ) {
        calls += 1;
        if (calls === 2) throw new TypeError('Reader left before final delivery');
        return enqueue.call(this, chunk);
      });

    try {
      const { response, pending } = await testApp(db)('note-proposal');
      await response.text();
      await Promise.all(pending);
    } finally {
      enqueueSpy.mockRestore();
    }

    expect(db.deletedSuggestions).toEqual([
      [attemptedProposal.id, 'owner', 'conversation', assistantMessage.id],
    ]);
  });

  it('removes every newly persisted batch operation when final delivery fails', async () => {
    const db = database();
    const second = { ...proposal, id: 'second', newText: 'Keep rollback available.' };
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal, operationIndex: 0 } as const;
        yield { type: 'done', proposal: second, proposals: [proposal, second] } as const;
      })(),
    );
    const enqueue = ReadableStreamDefaultController.prototype.enqueue;
    let calls = 0;
    const enqueueSpy = vi
      .spyOn(ReadableStreamDefaultController.prototype, 'enqueue')
      .mockImplementation(function (
        this: ReadableStreamDefaultController<Uint8Array>,
        chunk: Uint8Array,
      ) {
        calls += 1;
        if (calls === 2) throw new TypeError('Reader left before final delivery');
        return enqueue.call(this, chunk);
      });

    try {
      const { response, pending } = await testApp(db)('note-proposal');
      await response.text();
      await Promise.all(pending);
    } finally {
      enqueueSpy.mockRestore();
    }

    expect(db.deletedSuggestions).toEqual([
      ['proposal-attempt', 'owner', 'conversation', assistantMessage.id],
      ['proposal-attempt:1', 'owner', 'conversation', assistantMessage.id],
    ]);
  });

  it('leaves a raced existing suggestion intact when cancellation lands during replay', async () => {
    const db = database();
    let finishPersistence!: (value: {
      noteId: string;
      suggestion: typeof proposal;
      created: boolean;
    }) => void;
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal } as const;
      })(),
    );
    mocks.persistNoteSuggestion.mockReturnValue(
      new Promise((resolve) => {
        finishPersistence = resolve;
      }),
    );

    const { response, pending } = await testApp(db)('note-proposal');
    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(mocks.persistNoteSuggestion).toHaveBeenCalledTimes(1));
    await reader.cancel();
    finishPersistence({ noteId: 'note', suggestion: proposal, created: false });
    await Promise.all(pending);

    expect(db.deletedSuggestions).toEqual([]);
  });

  it('does not start persistence when cancellation lands during final validation', async () => {
    let finishValidation!: (value: Conversation) => void;
    mocks.loadConversation.mockResolvedValueOnce(conversation()).mockReturnValueOnce(
      new Promise((resolve) => {
        finishValidation = resolve;
      }),
    );
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(mocks.loadConversation).toHaveBeenCalledTimes(2));
    await reader.cancel();
    finishValidation(conversation());
    await Promise.all(pending);

    expect(mocks.persistNoteSuggestion).not.toHaveBeenCalled();
  });

  it('emits the persisted real note identity after a first-note final', async () => {
    const withoutNote = { ...conversation(), noteId: null };
    const preview = { ...proposal, noteId: 'unsaved-note', baseRevision: 0, oldText: '' };
    const attemptedPreview = { ...preview, id: 'proposal-attempt' };
    const persisted = { ...attemptedPreview, noteId: 'created-note' };
    mocks.loadConversation.mockResolvedValue(withoutNote);
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal: preview } as const;
        yield { type: 'done', proposal: preview } as const;
      })(),
    );
    mocks.persistNoteSuggestion.mockResolvedValue({
      noteId: 'created-note',
      suggestion: persisted,
      created: true,
    });

    const { response, pending } = await testApp(database())('note-proposal', null);
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toEqual([
      { type: 'preview', proposal: attemptedPreview },
      { type: 'done', proposal: persisted },
    ]);
    expect(mocks.persistNoteSuggestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedNoteId: null, expectedRevision: null }),
    );
  });

  it('keeps previews ephemeral when generation completes without a final suggestion', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal: null } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toEqual([
      { type: 'preview', proposal: attemptedProposal },
      { type: 'done', proposal: null },
    ]);
    expect(mocks.persistNoteSuggestion).not.toHaveBeenCalled();
  });

  it('preserves unrelated typing and persists the proposal against the latest revision', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'done', proposal } as const;
      })(),
    );
    const { response, pending } = await testApp(
      database(3, { markdown: 'Deployment notes.\n\nOther user writing.', revision: 4 }),
    )('note-proposal');
    const body = await response.text();
    await Promise.all(pending);
    expect(events(body).at(-1)).toMatchObject({
      type: 'done',
      proposal: { ...attemptedProposal, baseRevision: 4 },
    });
    expect(mocks.persistNoteSuggestion.mock.calls[0][1]).toMatchObject({ expectedRevision: 4 });
  });

  it('reports a recoverable conflict rather than silently losing an overlapping proposal', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'done', proposal } as const;
      })(),
    );
    const { response, pending } = await testApp(
      database(3, { markdown: 'A different deployment.', revision: 4 }),
    )('note-proposal');
    const body = await response.text();
    await Promise.all(pending);
    expect(events(body).at(-1)).toMatchObject({ type: 'error' });
    expect(mocks.persistNoteSuggestion).not.toHaveBeenCalled();
  });

  it('replays a stored pending suggestion without calling the model', async () => {
    const stored = {
      ...proposal,
      noteId: 'persisted-note',
      baseRevision: 0,
      conversationId: 'conversation',
      sourceMessageId: assistantMessage.id,
      createdAt: '2026-09-18T12:01:00.000Z',
      updatedAt: '2026-09-18T12:01:00.000Z',
    };
    mocks.loadConversation.mockResolvedValue(conversation());
    const second = { ...stored, id: 'stored-second', reason: 'Second operation.' };
    mocks.loadNoteSuggestionBatch.mockResolvedValue([stored, second]);

    const { response } = await testApp(database())('note-proposal');

    expect(events(await response.text())).toEqual([
      { type: 'done', proposal: second, proposals: [stored, second] },
    ]);
    expect(mocks.createAgentService).not.toHaveBeenCalled();
    expect(mocks.streamNoteProposal).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'dismissed', 'invalidated'] as const)(
    'does not regenerate a stored %s suggestion decision',
    async (status) => {
      mocks.loadConversation.mockResolvedValue(conversation());
      mocks.loadNoteSuggestionBatch.mockResolvedValue([
        {
          ...proposal,
          status,
          conversationId: 'conversation',
          sourceMessageId: assistantMessage.id,
          createdAt: '2026-09-18T12:01:00.000Z',
          updatedAt: '2026-09-18T12:01:00.000Z',
        },
      ]);

      const { response } = await testApp(database())('note-proposal');

      expect(events(await response.text())).toEqual([
        { type: 'done', proposal: null, proposals: [] },
      ]);
      expect(mocks.createAgentService).not.toHaveBeenCalled();
    },
  );

  it.each(['accepted', 'dismissed', 'invalidated'] as const)(
    'generates a fresh explicitly requested proposal after a stored %s decision',
    async (status) => {
      mocks.loadConversation.mockResolvedValue(conversation());
      mocks.loadNoteSuggestionBatch.mockResolvedValue([
        {
          ...proposal,
          status,
          conversationId: 'conversation',
          sourceMessageId: assistantMessage.id,
          createdAt: '2026-09-18T12:01:00.000Z',
          updatedAt: '2026-09-18T12:01:00.000Z',
        },
      ]);
      mocks.streamNoteProposal.mockResolvedValue(
        (async function* () {
          yield { type: 'done', proposal: { ...proposal, id: 'fresh-proposal' } } as const;
        })(),
      );

      const { response, pending } = await testApp(database())('note-proposal', 3, false, true);
      const body = await response.text();
      await Promise.all(pending);

      expect(events(body).at(-1)).toMatchObject({
        type: 'done',
        proposal: { id: 'proposal-attempt', status: 'pending' },
      });
      expect(mocks.persistNoteSuggestion.mock.calls[0][1]).toMatchObject({
        sourceMessageId: assistantMessage.id,
        expectedRevision: 3,
        allowAfterDecision: true,
        proposal: { id: 'proposal-attempt' },
      });
    },
  );

  it('persists an older response proposal when newer conversation messages arrive during inference', async () => {
    mocks.loadConversation
      .mockResolvedValueOnce(conversation())
      .mockResolvedValueOnce(
        conversation([
          userMessage,
          assistantMessage,
          { ...userMessage, id: 'new-user-message', content: 'One more thing.' },
        ]),
      );
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal } as const;
      })(),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toEqual([
      { type: 'preview', proposal: attemptedProposal },
      { type: 'done', proposal: attemptedProposal },
    ]);
    expect(mocks.persistNoteSuggestion.mock.calls[0][1]).toMatchObject({
      conversationId: 'conversation',
      sourceMessageId: assistantMessage.id,
      expectedRevision: 3,
    });
  });

  it.each([
    ['removed', conversation([userMessage])],
    ['expired', { ...conversation(), expiresAt: '2000-01-01T00:00:00.000Z' }],
  ])(
    'does not persist when the source response is %s before inference completes',
    async (_case, latest) => {
      mocks.loadConversation.mockResolvedValueOnce(conversation()).mockResolvedValueOnce(latest);
      mocks.streamNoteProposal.mockResolvedValue(
        (async function* () {
          yield { type: 'preview', proposal } as const;
          yield { type: 'done', proposal } as const;
        })(),
      );

      const { response, pending } = await testApp(database())('note-proposal');
      const body = await response.text();
      await Promise.all(pending);

      expect(events(body)).toEqual([
        { type: 'preview', proposal: attemptedProposal },
        { type: 'done', proposal: null },
      ]);
      expect(mocks.persistNoteSuggestion).not.toHaveBeenCalled();
    },
  );

  it('emits a retryable error when transactional final persistence detects a stale baseline', async () => {
    mocks.loadConversation.mockResolvedValue(conversation());
    mocks.streamNoteProposal.mockResolvedValue(
      (async function* () {
        yield { type: 'preview', proposal } as const;
        yield { type: 'done', proposal } as const;
      })(),
    );
    mocks.persistNoteSuggestion.mockRejectedValue(
      new HttpError(409, 'Conversation or note changed'),
    );

    const { response, pending } = await testApp(database())('note-proposal');
    const body = await response.text();
    await Promise.all(pending);

    expect(events(body)).toEqual([
      { type: 'preview', proposal: attemptedProposal },
      {
        type: 'error',
        message: 'The note changed before the suggestion was saved. Retry to use your latest text.',
      },
    ]);
  });
});
