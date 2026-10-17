// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Conversation } from '@walden/contracts';
import { expect, it } from 'vitest';
import {
  getTransport,
  hang,
  props,
  replyChunks,
  setComposerValue,
  textOf,
} from '../../tests/_ChatPanel.test-helpers';

const { ChatPanel } = await import('../../ChatPanel');

it('restarts the stream decoder at replacement and commits only the recovered reply', async () => {
  const stream = hang();
  const values = props();
  const view = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) =>
    view.rerender(<ChatPanel {...values} conversation={next} />),
  );
  setComposerValue(screen.getByLabelText('Message'), 'Question');
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(getTransport().startTurn).toHaveBeenCalledTimes(1));
  act(() =>
    stream.emit(
      {
        type: 'start',
        messageId: 'turn-1',
        messageMetadata: { createdAt: '2026-10-17T00:00:00Z' },
      },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Abandoned provisional text' },
    ),
  );
  await waitFor(() => expect(screen.getByText('Abandoned provisional text')).toBeTruthy());
  const recovered = replyChunks('turn-1', 'Recovered answer');
  const recoveredSse = recovered
    .map((chunk, index) => `id: ${index + 5}\ndata: ${JSON.stringify(chunk)}\n\n`)
    .join('');
  getTransport().turnEvents.mockResolvedValueOnce(
    new Response(`${recoveredSse}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
  act(() =>
    stream.emit({
      type: 'data-turn-replace',
      transient: true,
      data: { turnId: 'turn-1', generation: 1 },
    }),
  );
  await waitFor(() => expect(screen.getByText('Recovered answer')).toBeTruthy());
  expect(screen.queryByText(/Abandoned provisional/)).toBeNull();
  await waitFor(() =>
    expect(values.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ id: 'turn-1' })]),
      }),
    ),
  );
  const last = values.onConversation.mock.calls.at(-1)?.[0];
  expect(textOf(last?.messages.at(-1))).toBe('Recovered answer');
  expect(getTransport().turnEvents.mock.calls[1]?.slice(0, 2)).toEqual(['turn-1', 4]);
  expect(getTransport().startTurn).toHaveBeenCalledTimes(1);
});
