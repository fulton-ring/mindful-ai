// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Conversation } from '@walden/contracts';
import { expect, it } from 'vitest';
import {
  assistantMessage,
  conversation,
  getTransport,
  hang,
  props,
  reply,
  replyChunks,
  textChunks,
  textOf,
  turnData,
  userMessage,
} from '../../tests/_ChatPanel.test-helpers';

const { ChatPanel } = await import('../../ChatPanel');

const transport = getTransport();

function branchHistory(): Conversation {
  return {
    ...conversation('conversation-1'),
    messages: [
      userMessage('user-1', 'Original question'),
      assistantMessage('assistant-old', 'Original answer'),
      userMessage('user-later', 'Downstream question'),
      assistantMessage('assistant-later', 'Downstream answer'),
    ],
  };
}

it('creates a sibling branch from an older response without changing the original path', async () => {
  reply(
    replyChunks('assistant-new', 'Replacement', {
      body: [turnData({ branchId: 'branch-2', userMessageId: 'user-1' })],
    }),
  );
  transport.annotationResults.mockResolvedValue([]);
  transport.streamNoteProposal.mockResolvedValue(undefined);
  const history = branchHistory();
  const values = props(history);
  let latest = history;
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    latest = next;
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });

  const regenerate = screen.getAllByRole('button', { name: 'Regenerate response' })[0]!;
  fireEvent.click(regenerate);
  fireEvent.click(regenerate);

  await waitFor(() => expect(latest.messages.at(-1)?.id).toBe('assistant-new'));
  expect(values.onFlush).toHaveBeenCalledTimes(1);
  expect(transport.startTurn).toHaveBeenCalledTimes(1);
  expect(latest.branchId).toBe('branch-2');
  expect(latest.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-new']);
  expect(history.messages.map((message) => message.id)).toEqual([
    'user-1',
    'assistant-old',
    'user-later',
    'assistant-later',
  ]);
  expect(transport.startTurn.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      regenerateMessageId: 'assistant-old',
      branchId: 'branch-1',
      message: 'Original question',
    }),
  );
  // Arriving on the branch this turn created is not a thread switch: follow-ups keep running.
  await waitFor(() => expect(transport.annotationResults).toHaveBeenCalled());
  expect(transport.annotationResults.mock.calls[0]?.[0]).toBe('assistant-new');
  // Regenerating a response proposes nothing on its own.
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();
});

it('shows only the fork prefix while regenerating and restores the original path on cancel', async () => {
  const stream = hang();
  render(<ChatPanel {...props(branchHistory())} />);

  fireEvent.click(screen.getAllByRole('button', { name: 'Regenerate response' })[0]!);
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  act(() =>
    stream.emit(
      { type: 'start', messageId: 'turn-1', messageMetadata: { createdAt: '' } },
      ...textChunks('Sibling preview'),
    ),
  );

  await waitFor(() => expect(screen.getByText('Sibling preview')).toBeTruthy());
  expect(screen.getByText('Original question')).toBeTruthy();
  expect(screen.queryByText('Original answer')).toBeNull();
  expect(screen.queryByText('Downstream question')).toBeNull();
  expect(screen.queryByText('Downstream answer')).toBeNull();

  fireEvent.click(screen.getByLabelText('Stop response'));

  await waitFor(() => expect(screen.getByText('Original answer')).toBeTruthy());
  expect(transport.cancelTurn).toHaveBeenCalledWith('turn-1');
  expect(screen.getByText('Downstream question')).toBeTruthy();
  expect(screen.getByText('Downstream answer')).toBeTruthy();
  expect(screen.queryByText('Sibling preview')).toBeNull();
});

it('edits an earlier message onto a new branch and moves to it when the reply finishes', async () => {
  reply(
    replyChunks('assistant-edited', 'Edited answer', {
      body: [turnData({ branchId: 'branch-3', userMessageId: 'user-edited' })],
    }),
  );
  // Editing in place is offered on the question before an interrupted reply.
  const history = branchHistory();
  const values = props({
    ...history,
    messages: [
      ...history.messages.slice(0, 3),
      assistantMessage('assistant-later', '', { status: 'interrupted' }),
    ],
  });
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) =>
    rendered.rerender(<ChatPanel {...values} conversation={next} />),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
    target: { value: 'Better downstream question' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send edited message' }));

  expect(await screen.findByText('Better downstream question')).toBeTruthy();
  await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
  expect(transport.startTurn.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      editMessageId: 'user-later',
      message: 'Better downstream question',
      branchId: 'branch-1',
    }),
  );
  const saved = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
  expect(saved.branchId).toBe('branch-3');
  expect(saved.messages.map(({ id }) => id)).toEqual([
    'user-1',
    'assistant-old',
    'user-edited',
    'assistant-edited',
  ]);
  expect(textOf(saved.messages[2])).toBe('Better downstream question');
});

it('shows the selected branch path when the route switches branches', () => {
  const history = branchHistory();
  const values = props(history);
  const rendered = render(<ChatPanel {...values} />);
  expect(screen.getByText('Downstream answer')).toBeTruthy();
  rendered.rerender(
    <ChatPanel
      {...values}
      conversation={{
        ...history,
        branchId: 'branch-2',
        messages: [userMessage('user-1', 'Original question'), assistantMessage('b2', 'Sibling')],
      }}
    />,
  );
  expect(screen.getByText('Sibling')).toBeTruthy();
  expect(screen.queryByText('Downstream answer')).toBeNull();
  expect(transport.activeTurn).toHaveBeenLastCalledWith('conversation-1', 'branch-2');
});
