// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatEvent, Conversation } from '@walden/contracts';
import { expect, it } from 'vitest';
import { conversation, getTransport, props } from './_ChatPanel.test-helpers';
import { ChatPanel } from './ChatPanel';

const transport = getTransport();

function branchHistory() {
  return {
    ...conversation('conversation-1'),
    messages: [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'Original question',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'assistant-old',
        role: 'assistant' as const,
        content: 'Original answer',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'user-later',
        role: 'user' as const,
        content: 'Downstream question',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'assistant-later',
        role: 'assistant' as const,
        content: 'Downstream answer',
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

it('creates a sibling branch from an older response without changing the original path', async () => {
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text: 'Replacement' });
    onEvent({
      type: 'done',
      message: {
        id: 'assistant-new',
        role: 'assistant',
        content: 'Replacement',
        createdAt: new Date().toISOString(),
      },
      conversationId: 'conversation-1',
      branchId: 'branch-2',
      title: 'Thread',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
  });
  transport.messageAnnotations.mockResolvedValue([]);
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
  expect(transport.streamChat).toHaveBeenCalledTimes(1);
  expect(latest.branchId).toBe('branch-2');
  expect(latest.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-new']);
  expect(history.messages.map((message) => message.id)).toEqual([
    'user-1',
    'assistant-old',
    'user-later',
    'assistant-later',
  ]);
  expect(transport.streamChat.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      regenerateMessageId: 'assistant-old',
      branchId: 'branch-1',
      message: 'Original question',
    }),
  );
  // Regenerating a response proposes nothing on its own.
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();
});

it('shows only the fork prefix while regenerating and restores the original path on cancel', async () => {
  transport.streamChat.mockImplementation(
    async (_input, onEvent: (event: ChatEvent) => void, signal: AbortSignal) => {
      onEvent({ type: 'text', text: 'Sibling preview' });
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
  );
  const history = {
    ...conversation('conversation-1'),
    messages: [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'Fork question',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'assistant-old',
        role: 'assistant' as const,
        content: 'Original fork answer',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'user-later',
        role: 'user' as const,
        content: 'Downstream question',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'assistant-later',
        role: 'assistant' as const,
        content: 'Downstream answer',
        createdAt: new Date().toISOString(),
      },
    ],
  };
  render(<ChatPanel {...props(history)} />);

  fireEvent.click(screen.getAllByRole('button', { name: 'Regenerate response' })[0]!);

  await waitFor(() => expect(screen.getByText('Sibling preview')).toBeTruthy());
  expect(screen.getByText('Fork question')).toBeTruthy();
  expect(screen.queryByText('Original fork answer')).toBeNull();
  expect(screen.queryByText('Downstream question')).toBeNull();
  expect(screen.queryByText('Downstream answer')).toBeNull();

  fireEvent.click(screen.getByLabelText('Stop response'));

  await waitFor(() => expect(screen.getByText('Original fork answer')).toBeTruthy());
  expect(screen.getByText('Downstream question')).toBeTruthy();
  expect(screen.getByText('Downstream answer')).toBeTruthy();
  expect(screen.queryByText('Sibling preview')).toBeNull();
});
