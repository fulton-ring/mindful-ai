// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatEvent, Conversation } from '@walden/contracts';
import { expect, it } from 'vitest';
import { conversation, getTransport, props } from './_ChatPanel.test-helpers';
import { ChatPanel } from './ChatPanel';

const transport = getTransport();

it('publishes each annotation before the classifier stream finishes', async () => {
  let emitAnnotation: ((event: unknown) => void) | undefined;
  let finishAnnotations: (() => void) | undefined;
  transport.streamMessageAnnotations.mockImplementation(
    async (_messageId, _input, onEvent: (event: unknown) => void) => {
      emitAnnotation = onEvent;
      await new Promise<void>((resolve) => {
        finishAnnotations = resolve;
      });
    },
  );
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({
      type: 'done',
      message: {
        id: 'assistant-progressive',
        role: 'assistant',
        content: 'First claim. Second claim.',
        createdAt: new Date().toISOString(),
      },
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      title: 'Conversation',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
  });
  transport.streamNoteProposal.mockResolvedValue(undefined);
  const values = props();
  let latest = values.conversation;
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    latest = next;
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(emitAnnotation).toBeTypeOf('function'));
  emitAnnotation?.({
    type: 'annotation',
    annotation: {
      id: 'annotation-first',
      quote: 'First claim',
      kind: 'claim',
      whose: 'assistant',
    },
  });

  await waitFor(() =>
    expect(
      latest.messages.find((message) => message.id === 'assistant-progressive')?.annotations,
    ).toEqual([expect.objectContaining({ id: 'annotation-first' })]),
  );
  expect(finishAnnotations).toBeTypeOf('function');
  emitAnnotation?.({
    type: 'done',
    annotations: [
      {
        id: 'annotation-first',
        quote: 'First claim',
        kind: 'claim',
        whose: 'assistant',
      },
    ],
  });
  finishAnnotations?.();
});

function completedEvent(id: string, content: string): ChatEvent {
  return {
    type: 'done',
    message: { id, role: 'assistant', content, createdAt: new Date().toISOString() },
    conversationId: 'conversation-1',
    branchId: 'branch-1',
    title: 'Conversation',
    expiresAt: '2026-09-25T00:00:00.000Z',
  };
}

function configurePriorTurnStreams() {
  let finishFirstAnnotations: ((value: unknown[]) => void) | undefined;
  let emitSecond: ((event: ChatEvent) => void) | undefined;
  let turn = 0;
  transport.messageAnnotations
    .mockReturnValueOnce(new Promise((resolve) => (finishFirstAnnotations = resolve)))
    .mockReturnValue(new Promise(() => undefined));
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    turn += 1;
    if (turn === 1) {
      onEvent(completedEvent('assistant-first', 'First answer'));
      return;
    }
    emitSecond = onEvent;
    return new Promise<void>(() => undefined);
  });
  transport.streamNoteProposal.mockImplementation(
    async (_messageId, _input, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'done', proposal: null });
    },
  );
  return {
    finishFirstAnnotations: (value: unknown[]) => finishFirstAnnotations?.(value),
    secondReady: () => emitSecond !== undefined,
    finishSecond: () => emitSecond?.(completedEvent('assistant-second', 'Second answer')),
  };
}

async function beginPriorTurnScenario() {
  const streams = configurePriorTurnStreams();
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  let latest = values.conversation;
  values.onConversation.mockImplementation((next: Conversation) => {
    latest = next;
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'First' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await screen.findByText('First answer');
  expect(await screen.findByText('Adding highlights…')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Second' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(streams.secondReady()).toBe(true));
  return { ...streams, getLatest: () => latest };
}

it.each(['before', 'after'] as const)(
  'preserves prior-turn annotations that resolve %s the next turn completes',
  async (order) => {
    const { finishFirstAnnotations, finishSecond, getLatest } = await beginPriorTurnScenario();
    const annotation = {
      id: 'annotation-first',
      quote: 'First answer',
      kind: 'claim',
      whose: 'assistant',
    };
    if (order === 'before') {
      finishFirstAnnotations([annotation]);
      await waitFor(() =>
        expect(
          getLatest().messages.find((message) => message.id === 'assistant-first')?.annotations,
        ).toHaveLength(1),
      );
      finishSecond();
    } else {
      finishSecond();
      await screen.findByText('Second answer');
      finishFirstAnnotations([annotation]);
    }
    await waitFor(() => {
      expect(getLatest().messages).toHaveLength(4);
      expect(
        getLatest().messages.find((message) => message.id === 'assistant-first')?.annotations,
      ).toEqual([expect.objectContaining({ id: 'annotation-first' })]);
    });
  },
);

it('does not present an unfinished highlight action on an unannotated response', () => {
  const history = {
    ...conversation('conversation-1'),
    messages: [
      {
        id: 'assistant-history',
        role: 'assistant' as const,
        content: 'A historical response',
        createdAt: new Date().toISOString(),
      },
    ],
  };
  render(<ChatPanel {...props(history)} />);

  expect(screen.queryByRole('button', { name: 'Add highlights' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry highlights' })).toBeNull();
});

it('hides highlight controls after a successful empty classification', async () => {
  transport.messageAnnotations.mockResolvedValueOnce([]);
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({
      type: 'done',
      message: {
        id: 'assistant-empty',
        role: 'assistant',
        content: 'Acknowledged.',
        createdAt: new Date().toISOString(),
      },
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      title: 'Conversation',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
  });
  transport.streamNoteProposal.mockResolvedValue(undefined);
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Okay?' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await screen.findByText('Acknowledged.');
  await waitFor(() => expect(screen.queryByText('Adding highlights…')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Add highlights' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry highlights' })).toBeNull();
});

it('applies annotations that arrive after drain but before finalized props rerender', async () => {
  let finishAnnotations: ((value: unknown[]) => void) | undefined;
  transport.messageAnnotations.mockReturnValue(
    new Promise((resolve) => {
      finishAnnotations = resolve;
    }),
  );
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text: 'A useful claim' });
    onEvent({
      type: 'done',
      message: {
        id: 'assistant-delayed',
        role: 'assistant',
        content: 'A useful claim',
        createdAt: new Date().toISOString(),
      },
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      title: 'Conversation',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
  });
  transport.streamNoteProposal.mockImplementation(
    async (_messageId, _input, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'done', proposal: null });
    },
  );
  const values = props();
  let finalized: Conversation | undefined;
  values.onConversation.mockImplementation((next: Conversation) => {
    finalized ??= next;
  });
  const rendered = render(<ChatPanel {...values} />);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(finalized?.messages.at(-1)?.id).toBe('assistant-delayed'));

  finishAnnotations?.([
    {
      id: 'annotation-delayed',
      quote: 'useful claim',
      kind: 'claim',
      whose: 'assistant',
    },
  ]);
  await Promise.resolve();
  expect(values.onConversation).toHaveBeenCalledTimes(2);
  rendered.rerender(<ChatPanel {...values} conversation={finalized!} />);

  await waitFor(() =>
    expect(values.onConversation.mock.calls.at(-1)?.[0].messages.at(-1)?.annotations).toEqual([
      expect.objectContaining({ id: 'annotation-delayed' }),
    ]),
  );
});

it('explains and dismisses a failed highlight refresh while retaining existing marks', async () => {
  transport.messageAnnotations.mockRejectedValueOnce(
    new Error('The AI service is busy. Please try again shortly.'),
  );
  const values = props();
  values.conversation.messages = [
    {
      id: 'answer',
      role: 'assistant',
      content: 'Ice floats.',
      createdAt: '',
      annotations: [{ id: 'fact', kind: 'fact', whose: 'assistant', quote: 'Ice floats.' }],
    },
  ];
  render(<ChatPanel {...values} />);
  fireEvent.click(screen.getByRole('button', { name: 'Highlight response' }));
  expect(await screen.findByText('The AI service is busy. Please try again shortly.')).toBeTruthy();
  expect(screen.getByText('Ice floats.').getAttribute('data-annotation-count')).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss highlight error' }));
  expect(screen.queryByText('The AI service is busy. Please try again shortly.')).toBeNull();
  expect(screen.getByText('Ice floats.').getAttribute('data-annotation-count')).toBe('1');
  expect(transport.messageAnnotations).toHaveBeenCalledTimes(1);
});

it('retries only highlights with the original followup input', async () => {
  transport.messageAnnotations.mockRejectedValueOnce(new Error('classifier unavailable'));
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text: 'Completed answer' });
    onEvent({
      type: 'done',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Completed answer',
        createdAt: new Date().toISOString(),
      },
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      title: 'Conversation',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
  });
  transport.streamNoteProposal.mockImplementation(
    async (_messageId, _input, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'done', proposal: null });
    },
  );
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  const retry = await screen.findByRole('button', { name: 'Retry highlights' });
  const originalInput = transport.messageAnnotations.mock.calls[0]?.[1];
  let finishRetry: ((value: unknown[]) => void) | undefined;
  transport.messageAnnotations.mockReturnValueOnce(
    new Promise((resolve) => {
      finishRetry = resolve;
    }),
  );

  fireEvent.click(retry);
  expect(await screen.findByText('Adding highlights…')).toBeTruthy();
  expect(transport.messageAnnotations).toHaveBeenCalledTimes(2);
  expect(transport.messageAnnotations.mock.calls[1]?.[0]).toBe('assistant-1');
  expect(transport.messageAnnotations.mock.calls[1]?.[1]).toEqual(originalInput);
  // Retrying highlights touches only highlights; nothing proposes a note.
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();
  finishRetry?.([]);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Retry highlights' })).toBeNull(),
  );
});
