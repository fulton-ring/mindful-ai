import { expect, it } from 'vitest';
import { HttpError } from '../../../http';
import { textMessage } from '../../../tests/ui-messages';
import {
  assistantMessage,
  attemptedProposal,
  conversation,
  database,
  events,
  getMocks,
  proposal,
  testApp,
  userMessage,
} from './followups-fixture';

const mocks = getMocks();

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
      conversation([assistantMessage, textMessage('new-user-message', 'user', 'One more thing.')]),
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
  mocks.persistNoteSuggestion.mockRejectedValue(new HttpError(409, 'Conversation or note changed'));

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
