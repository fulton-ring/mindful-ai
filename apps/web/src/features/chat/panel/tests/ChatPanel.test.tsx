// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Conversation } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../../lib/api';
import {
  composerValue,
  conversation,
  getTransport,
  hang,
  props,
  replyChunks,
  setComposerValue,
  textOf,
  turnData,
} from '../../tests/_ChatPanel.test-helpers';

const { ChatPanel } = await import('../../ChatPanel');

const transport = getTransport();

function send(text: string) {
  setComposerValue(screen.getByLabelText('Message'), text);
  fireEvent.click(screen.getByLabelText('Send message'));
}

describe('sending', () => {
  it('shows the message at once, posts the turn, and saves the streamed reply', async () => {
    const stream = hang();
    const values = props();
    const view = render(<ChatPanel {...values} />);
    values.onConversation.mockImplementation((next: Conversation) =>
      view.rerender(<ChatPanel {...values} conversation={next} />),
    );
    send('What floats?');
    expect(screen.getByText('What floats?')).toBeTruthy();
    await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(1));
    expect(transport.startTurn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        noteRevision: null,
        message: 'What floats?',
        action: 'message',
        personaId: 'thinking-partner',
        requestId: expect.stringMatching(/^turn/),
      }),
    );
    act(() => {
      stream.emit(
        ...replyChunks('turn-1', 'Ice floats.').slice(0, -1),
        { type: 'data-status', transient: true, data: { text: 'Searching the web…' } },
        turnData({
          userMessageId: 'user-saved',
          title: 'Floating',
          expiresAt: '2026-10-01T00:00:00.000Z',
        }),
      );
      stream.emit({ type: 'finish' });
      stream.done();
    });
    await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
    const saved = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
    expect(saved.title).toBe('Floating');
    expect(saved.expiresAt).toBe('2026-10-01T00:00:00.000Z');
    expect(saved.messages.map(({ id }) => id)).toEqual(['user-saved', 'turn-1']);
    expect(textOf(saved.messages[1])).toBe('Ice floats.');
    expect(screen.getAllByText('Ice floats.')).toHaveLength(1);
    expect(screen.getByLabelText('Send message')).toBeTruthy();
  });

  it('shows data-status progress while the reply has no text', async () => {
    const stream = hang();
    render(<ChatPanel {...props()} />);
    send('Question');
    expect(await screen.findByText('Thinking…')).toBeTruthy();
    await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
    act(() =>
      stream.emit(
        { type: 'start', messageId: 'turn-1', messageMetadata: { createdAt: '' } },
        { type: 'data-status', transient: true, data: { text: 'Searching the web…' } },
      ),
    );
    expect(await screen.findByText('Searching the web…')).toBeTruthy();
  });
});

describe('streamed response activity', () => {
  it('updates tools in place, exposes sources, and clears activity when switching threads', async () => {
    const stream = hang();
    const values = props();
    const view = render(<ChatPanel {...values} />);
    send('Read a page');
    await waitFor(() => expect(transport.turnEvents).toHaveBeenCalledTimes(1));
    act(() =>
      stream.emit(
        {
          type: 'start',
          messageId: 'turn-1',
          messageMetadata: { createdAt: '', contextCompacted: true },
        },
        { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'readWebPage' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-1',
          toolName: 'readWebPage',
          input: { query: 'https://example.com/' },
        },
      ),
    );
    expect(await screen.findByLabelText('Context compacted')).toBeTruthy();
    // Open already, with no click: while the turn is running this panel is the
    // only progress the reader gets, and a collapsed one made a multi-second
    // tool call look like the app had stalled and then answered all at once.
    expect(await screen.findByText('Read page')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.queryByText('Read page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    act(() =>
      stream.emit(
        {
          type: 'tool-output-available',
          toolCallId: 'call-1',
          output: { sources: [{ url: 'https://example.com/', title: 'Example Domain' }] },
        },
        {
          type: 'source-url',
          sourceId: 'source-1',
          url: 'https://example.com/',
          title: 'Example Domain',
        },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'The page says hello.' },
      ),
    );
    expect(await screen.findByText('Completed')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
    const assistant = document.querySelector('article.message.assistant');
    const activity = assistant?.querySelector('[aria-label="Response activity"]');
    const responseText = await screen.findByText('The page says hello.');
    const sources = assistant?.querySelector('[aria-label="Response sources"]');
    expect(activity?.compareDocumentPosition(responseText)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(responseText.compareDocumentPosition(sources as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByRole('button', { name: '1 source' })).toBeTruthy();
    expect(activity?.contains(screen.getByRole('link', { name: 'Example Domain' }))).toBe(true);
    view.rerender(<ChatPanel {...props(conversation('conversation-2'))} />);
    await waitFor(() => expect(screen.queryByLabelText('Context compacted')).toBeNull());
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Example Domain' })).toBeNull();
    // Switching threads detaches; it never cancels the server turn.
    expect(transport.cancelTurn).not.toHaveBeenCalled();
  });
});

describe('prompt tools', () => {
  it('lets people turn automatic highlights off', () => {
    render(<ChatPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
    const highlights = screen.getByRole('checkbox', { name: 'Auto highlights' });
    expect((highlights as HTMLInputElement).checked).toBe(true);
    fireEvent.click(highlights);
    expect((highlights as HTMLInputElement).checked).toBe(false);
    // There is no note toggle: suggestions are only ever asked for, so there is
    // nothing automatic to switch off.
    expect(screen.queryByRole('checkbox', { name: 'Auto note suggestions' })).toBeNull();
  });
});

it.each([
  { action: 'enables', initial: false, next: true },
  { action: 'disables', initial: true, next: false },
])('$action learning checks without sending a message', async ({ initial, next }) => {
  const value = { ...conversation('quiz-toggle'), learningChecksEnabled: initial };
  const callbacks = props(value);
  transport.setLearningChecks.mockImplementation(async (_id, enabled) => ({
    learningChecksEnabled: enabled,
  }));
  const view = render(<ChatPanel {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
  const toggle = screen.getByRole('checkbox', { name: 'Learning checks' });
  expect((toggle as HTMLInputElement).checked).toBe(initial);
  await act(async () => {
    fireEvent.click(toggle);
  });
  await waitFor(() =>
    expect(callbacks.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({ learningChecksEnabled: next }),
    ),
  );
  expect(transport.setLearningChecks).toHaveBeenLastCalledWith(value.id, next);
  expect(transport.startTurn).not.toHaveBeenCalled();
  view.unmount();
});

it.each([
  { action: 'disables', initial: true, next: false },
  { action: 'enables', initial: false, next: true },
])('$action web search without sending a message', async ({ initial, next }) => {
  const value = { ...conversation('search-toggle'), webSearchEnabled: initial };
  const callbacks = props(value);
  transport.setWebSearch.mockImplementation(async (_id, enabled) => ({
    webSearchEnabled: enabled,
  }));
  const view = render(<ChatPanel {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
  const toggle = screen.getByRole('checkbox', { name: 'Web search' });
  expect((toggle as HTMLInputElement).checked).toBe(initial);
  await act(async () => {
    fireEvent.click(toggle);
  });
  await waitFor(() =>
    expect(callbacks.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({ webSearchEnabled: next }),
    ),
  );
  expect(transport.setWebSearch).toHaveBeenLastCalledWith(value.id, next);
  expect(transport.startTurn).not.toHaveBeenCalled();
  view.unmount();
});

describe('message limit', () => {
  it('shows the limit and keeps the draft when the server refuses the message', async () => {
    transport.startTurn.mockRejectedValueOnce(
      new ApiError(429, "You've reached your message limit. It resets in 2h 10m."),
    );
    render(<ChatPanel {...props()} />);
    send('One more question');
    expect(await screen.findByText(/reached your message limit/)).toBeTruthy();
    expect(transport.startTurn).toHaveBeenCalledTimes(1);
    expect(composerValue(screen.getByLabelText('Message'))).toBe('One more question');
    // The refused message is not left in the transcript.
    expect(document.querySelector('article.message.user')).toBeNull();
  });
});
