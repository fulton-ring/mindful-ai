import type { Conversation } from '@walden/contracts';
import { expect, it, vi } from 'vitest';
import {
  assistantMessage,
  attemptedProposal,
  conversation,
  database,
  events,
  getMocks,
  proposal,
  testApp,
} from './followups-fixture';

const mocks = getMocks();

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
