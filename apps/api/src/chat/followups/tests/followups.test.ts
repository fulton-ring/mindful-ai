import { uiMessageText } from '@walden/contracts';
import { expect, it } from 'vitest';
import { HttpError } from '../../../http';
import { textMessage } from '../../../tests/ui-messages';
import type { Bindings } from '../../../types';
import {
  assistantMessage,
  attemptedProposal,
  conversation,
  database,
  events,
  getMocks,
  proposal,
  testApp,
  testRouter,
  userMessage,
} from './followups-fixture';

const mocks = getMocks();

it('durably cancels only the exact note proposal attempt', async () => {
  mocks.cancelNoteSuggestionAttempt.mockResolvedValue({
    noteId: 'note',
    cancelledSuggestionIds: ['attempt-new', 'attempt-new:1'],
  });
  mocks.loadNoteState.mockResolvedValue({ note: { id: 'note' }, suggestions: [] });
  const app = testRouter();

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
    { DB: database() } as unknown as Bindings,
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
  [
    'incomplete',
    [
      userMessage,
      {
        ...assistantMessage,
        metadata: { ...assistantMessage.metadata!, status: 'interrupted' as const },
      },
    ],
  ],
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
  const laterUser = textMessage('later-user', 'user', 'A later question.');
  const laterAssistant = textMessage('later-assistant', 'assistant', 'A later answer.');
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
      message: uiMessageText(userMessage),
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
    expect.objectContaining({ turnId: 'turn', message: uiMessageText(userMessage) }),
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
    conversation([
      userMessage,
      { ...assistantMessage, metadata: { ...assistantMessage.metadata!, annotations: [existing] } },
    ]),
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
    conversation([
      userMessage,
      { ...assistantMessage, metadata: { ...assistantMessage.metadata!, annotations } },
    ]),
  );

  const { response } = await testApp(database())('annotations', 3, true);

  expect(events(await response.text())).toEqual([{ type: 'done', annotations }]);
  expect(mocks.createAgentService).not.toHaveBeenCalled();
});
