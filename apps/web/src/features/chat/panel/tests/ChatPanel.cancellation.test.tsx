// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AnnotationEvent, Conversation } from '@walden/contracts';
import { expect, it, vi } from 'vitest';
import {
  assistantMessage,
  composerValue,
  conversation,
  getTransport,
  hang,
  openTurn,
  props,
  reply,
  replyChunks,
  setComposerValue,
  textChunks,
  turnData,
  userMessage,
} from '../../tests/_ChatPanel.test-helpers';

const { track } = await import('../../../../lib/telemetry');
const { ChatPanel } = await import('../../ChatPanel');

const transport = getTransport();

function send(text: string) {
  setComposerValue(screen.getByLabelText('Message'), text);
  fireEvent.click(screen.getByLabelText('Send message'));
}

function renderSaving(values = props()) {
  const view = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) =>
    view.rerender(<ChatPanel {...values} conversation={next} />),
  );
  return { values, view };
}

it('detaches on unmount without cancelling a running turn', async () => {
  hang();
  const rendered = render(<ChatPanel {...props()} />);
  send('Question');
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  rendered.unmount();
  expect(transport.cancelTurn).not.toHaveBeenCalled();
});

it('resumes a running turn on mount and saves the replayed answer once', async () => {
  const initial = {
    ...conversation('conversation-1'),
    messages: [userMessage('user-1', 'Question')],
  };
  transport.activeTurn.mockResolvedValue({
    turn: {
      id: 'turn-1',
      requestId: 'request-1',
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      userMessageId: 'user-1',
    },
  });
  const stream = openTurn('turn-1', { admit: false });
  const { values } = renderSaving(props(initial));
  expect(await screen.findByText('Reconnecting…')).toBeTruthy();
  expect(transport.turnEvents).toHaveBeenCalledWith('turn-1', 0, expect.any(AbortSignal));
  act(() => {
    stream.emit(...replyChunks('turn-1', 'A saved answer'));
    stream.done();
  });
  await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
  const saved = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
  expect(saved.messages.map(({ id }) => id)).toEqual(['user-1', 'turn-1']);
  expect(screen.getAllByText('A saved answer')).toHaveLength(1);
  expect(transport.startTurn).not.toHaveBeenCalled();
});

it('preserves a saved removal when a late classifier result updates the message', async () => {
  const message = assistantMessage('highlight-source', 'Ice floats.');
  const values = props({ ...conversation('conversation-1'), messages: [message] });
  let emit: ((event: AnnotationEvent) => void) | undefined;
  let finish: (() => void) | undefined;
  transport.streamMessageAnnotations.mockImplementation((_id, _input, onEvent) => {
    emit = onEvent;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  transport.saveHighlight.mockImplementation(async (_id, value) => value);
  render(<ChatPanel {...values} />);
  fireEvent.click(screen.getByRole('button', { name: 'Highlight response' }));
  await waitFor(() => expect(emit).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Remove highlight' }));
  await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
  await act(async () => {
    emit?.({
      type: 'done',
      annotations: [{ id: 'late', quote: 'Ice floats.', kind: 'fact', whose: 'assistant' }],
    });
    finish?.();
  });
  const updated = values.onConversation.mock.calls.at(-1)?.[0].messages[0];
  expect(updated?.metadata?.annotations).toHaveLength(1);
  expect(updated?.metadata?.highlights).toEqual([
    { start: 0, end: 11, quote: 'Ice floats.', color: null, origin: 'user' },
  ]);
});

it('stops following when the reader scrolls slightly up and resumes only at the bottom', async () => {
  const stream = hang();
  const view = render(<ChatPanel {...props()} />);
  send('Question');
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  act(() =>
    stream.emit(
      { type: 'start', messageId: 'turn-1', messageMetadata: { createdAt: '' } },
      { type: 'text-start', id: 'text' },
    ),
  );
  const scroll = view.container.querySelector('.chat-scroll')!;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: 760 },
  });
  fireEvent.wheel(scroll, { deltaY: -40 });
  fireEvent.scroll(scroll);
  vi.mocked(HTMLElement.prototype.scrollTo).mockClear();
  act(() => stream.emit({ type: 'text-delta', id: 'text', delta: 'More text' }));
  await screen.findByText('More text');
  expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  scroll.scrollTop = 800;
  fireEvent.scroll(scroll);
  act(() => stream.emit({ type: 'text-delta', id: 'text', delta: ' continues' }));
  await screen.findByText('More text continues');
  expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'instant' });
});

it('uses the first available persona when the built-in default is unavailable', async () => {
  hang();
  const custom = {
    id: 'custom-only',
    name: 'Custom coach',
    prompt: 'Help clearly.',
    brevity: 'brief' as const,
    challenge: 'balanced' as const,
    tone: 'neutral' as const,
  };
  render(<ChatPanel {...props()} personas={[custom]} />);
  send('Question');
  await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(1));
  expect(transport.startTurn.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ personaId: 'custom-only' }),
  );
});

it('keeps the first turn alive when its newly created conversation route is adopted', async () => {
  let finishEnsure: ((value: Conversation) => void) | undefined;
  const stream = hang();
  const created = { ...conversation('conversation-created'), title: 'New thread' };
  const values = props(created);
  values.onEnsureConversation.mockReturnValue(
    new Promise<Conversation>((resolve) => {
      finishEnsure = resolve;
    }),
  );
  const rendered = render(<ChatPanel {...values} conversation={null} scopeId={null} />);
  send('First question');
  await waitFor(() => expect(values.onEnsureConversation).toHaveBeenCalledTimes(1));
  rendered.rerender(<ChatPanel {...values} conversation={created} scopeId={created.id} />);
  finishEnsure?.(created);
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  expect(transport.startTurn.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ conversationId: 'conversation-created' }),
  );
  // An untitled thread is named after its first message.
  expect(values.onConversation).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'First question' }),
  );
  act(() =>
    stream.emit(
      { type: 'start', messageId: 'turn-1', messageMetadata: { createdAt: '' } },
      ...textChunks('Visible first token'),
    ),
  );
  expect(await screen.findByText('Visible first token')).toBeTruthy();
  expect(screen.getByText('First question')).toBeTruthy();
  expect(transport.cancelTurn).not.toHaveBeenCalled();
});

it('switches to the full-height conversation layout as soon as submit begins', async () => {
  const values = props();
  values.onFlush.mockReturnValue(new Promise<null>(() => undefined));
  render(<ChatPanel {...values} />);
  expect(screen.getByLabelText('Thread').classList).toContain('empty-conversation');
  send('Question');
  expect(screen.getByLabelText('Thread').classList).not.toContain('empty-conversation');
  expect(screen.getByText('Question')).toBeTruthy();
  expect(await screen.findByText('Thinking…')).toBeTruthy();
  expect(transport.startTurn).not.toHaveBeenCalled();
});

it('stops durably, keeps interrupted text, unlocks the composer, and retries by editing', async () => {
  const stream = hang();
  const { values } = renderSaving();
  send('Question');
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  act(() =>
    stream.emit(
      { type: 'start', messageId: 'turn-1', messageMetadata: { createdAt: '' } },
      turnData({ userMessageId: 'user-saved' }),
      ...textChunks('Partial answer'),
    ),
  );
  await screen.findByText('Partial answer');
  fireEvent.click(screen.getByLabelText('Stop response'));
  expect(transport.cancelTurn).toHaveBeenCalledWith('turn-1');
  expect(await screen.findByText('Incomplete response')).toBeTruthy();
  expect(screen.getByLabelText('Send message')).toBeTruthy();
  const saved = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
  expect(saved.messages.at(-1)).toMatchObject({
    id: 'turn-1',
    metadata: expect.objectContaining({ status: 'interrupted' }),
  });
  // A late event on the detached stream changes nothing.
  act(() => stream.emit(...textChunks(' and more', 'late')));
  expect(values.onConversation).toHaveBeenCalledTimes(1);
  expect(transport.streamMessageAnnotations).not.toHaveBeenCalled();
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();

  hang('turn-2');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(2));
  expect(transport.startTurn.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({ message: 'Question', editMessageId: 'user-saved' }),
  );
  expect(screen.queryByText('Partial answer')).toBeNull();
});

it('retries a turn stopped before its first event under the server user message id', async () => {
  openTurn('turn-1', { userMessageId: 'user-saved' });
  renderSaving();
  send('Question');
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText('Stop response'));
  expect(transport.cancelTurn).toHaveBeenCalledWith('turn-1');
  hang('turn-2');
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(2));
  expect(transport.startTurn.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({ message: 'Question', editMessageId: 'user-saved' }),
  );
});

it('waits for stop acknowledgement before starting another turn', async () => {
  let acknowledge: (() => void) | undefined;
  transport.cancelTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = () => resolve({ cancelled: true });
      }),
  );
  hang();
  render(<ChatPanel {...props()} />);
  send('First');
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Stop response'));
  await screen.findByText('No response received');
  hang('turn-2');
  setComposerValue(screen.getByLabelText('Message'), 'Second');
  await act(async () => fireEvent.click(screen.getByLabelText('Send message')));
  expect(transport.startTurn).toHaveBeenCalledTimes(1);
  await act(async () => acknowledge?.());
  await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(2));
});

it('offers recovery immediately when stopped before the first token', async () => {
  hang();
  renderSaving();
  send('Keep this question');
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Stop response'));
  expect(await screen.findByText('No response received')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
  expect((screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value).toBe(
    'Keep this question',
  );
  expect(transport.startTurn).toHaveBeenCalledTimes(1);
  expect(transport.cancelTurn).toHaveBeenCalledTimes(1);
});

it('cancels by request id and restores the draft when stopped before the turn is admitted', async () => {
  transport.startTurn.mockImplementationOnce(
    (_request, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  );
  render(<ChatPanel {...props()} />);
  send('Not yet sent');
  await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Stop response'));
  const requestId = transport.startTurn.mock.calls[0]?.[0].requestId;
  expect(transport.cancelTurn).toHaveBeenCalledWith(requestId);
  await waitFor(() => expect(composerValue(screen.getByLabelText('Message'))).toBe('Not yet sent'));
  expect(document.querySelector('article.message.user')).toBeNull();
});

it('restores the latest failed question without sending or overwriting a draft', () => {
  const values = props();
  values.conversation.messages = [
    userMessage('question', 'Original question'),
    assistantMessage('failed', '', { status: 'interrupted' }),
  ];
  render(<ChatPanel {...values} />);
  expect(screen.getByText('No response received')).toBeTruthy();
  const composer = screen.getByLabelText('Message') as HTMLTextAreaElement;
  setComposerValue(composer, 'Unsent draft');
  const retry = screen.getByRole('button', { name: 'Edit message' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  fireEvent.click(retry);
  expect(composerValue(composer)).toBe('Unsent draft');
  setComposerValue(composer, '');
  fireEvent.click(retry);
  expect((screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value).toBe(
    'Original question',
  );
  expect(transport.startTurn).not.toHaveBeenCalled();
});

it('keeps a partial reply as interrupted when the stream reports an error', async () => {
  reply([
    {
      type: 'start',
      messageId: 'turn-1',
      messageMetadata: { createdAt: '', contextCompacted: true },
    },
    { type: 'reasoning-start', id: 'reasoning' },
    { type: 'reasoning-delta', id: 'reasoning', delta: 'Reasoning retained' },
    { type: 'reasoning-end', id: 'reasoning' },
    ...textChunks('Partial output'),
    turnData({ failureCode: 'output_limit' }),
    { type: 'message-metadata', messageMetadata: { status: 'interrupted' } },
    { type: 'error', errorText: 'The response reached its output limit. Please try again.' },
  ]);
  const { values } = renderSaving();
  send('Question');
  expect(await screen.findByText(/reached its output limit/)).toBeTruthy();
  await waitFor(() => expect(values.onConversation).toHaveBeenCalledTimes(1));
  const adopted = values.onConversation.mock.calls[0]?.[0] as Conversation;
  expect(adopted.messages.at(-1)).toMatchObject({
    id: 'turn-1',
    metadata: expect.objectContaining({ status: 'interrupted', contextCompacted: true }),
  });
  expect(screen.getAllByText('Partial output')).toHaveLength(1);
  expect(screen.getByText('Reasoning retained')).toBeTruthy();
  expect(screen.getByText('Incomplete response')).toBeTruthy();
  expect(screen.getByLabelText('Context compacted')).toBeTruthy();
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();
  expect(track).toHaveBeenCalledWith(
    'chat_failed',
    expect.objectContaining({ failure_code: 'output_limit' }),
  );
});

it('does not start a turn when navigation happens during preflight', async () => {
  let finishFlush: ((value: null) => void) | undefined;
  const first = props();
  first.onFlush.mockReturnValue(
    new Promise<null>((resolve) => {
      finishFlush = resolve;
    }),
  );
  const rendered = render(<ChatPanel {...first} />);
  send('Question');
  rendered.rerender(<ChatPanel {...props(conversation('conversation-2'))} />);
  await act(async () => finishFlush?.(null));
  expect(transport.startTurn).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Send message')).toBeTruthy();
  expect(screen.queryByText('Question')).toBeNull();
});

it('keeps the streamed response element when the saved conversation arrives', async () => {
  reply(replyChunks('turn-1', 'Completed answer'));
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  send('Question');
  await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
  const liveArticle = screen.getByText('Completed answer').closest('article');
  const finalized = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
  rendered.rerender(<ChatPanel {...values} conversation={finalized} />);
  expect(screen.getAllByText('Completed answer')).toHaveLength(1);
  expect(screen.getByText('Completed answer').closest('article')).toBe(liveArticle);
  rendered.unmount();
  expect(transport.cancelTurn).not.toHaveBeenCalled();
});

it('sends uploaded files as attachments and clears them when sending starts', async () => {
  hang();
  const view = render(<ChatPanel {...props()} />);
  const composer = view.container.querySelector<HTMLElement>('.composer');
  if (!composer) throw new Error('Composer missing');
  const file = new File(['docx'], 'paper.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });
  expect(within(composer).getByRole('button', { name: 'Download paper.docx' })).toBeTruthy();
  await waitFor(() => expect(transport.uploadAttachment).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(transport.startTurn).toHaveBeenCalledOnce());
  expect(transport.startTurn.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ attachmentIds: ['uploaded'], message: '' }),
  );
  expect(within(composer).queryByRole('button', { name: 'Download paper.docx' })).toBeNull();
  // The sent message shows the attachment from its `file` part.
  const sent = document.querySelector<HTMLElement>('article.message.user');
  expect(within(sent!).getByRole('button', { name: 'Download paper.docx' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop response' })).toBeTruthy();
});

it('removes a failed attachment, shows an error, and does not send it', async () => {
  transport.uploadAttachment.mockRejectedValueOnce(new Error('Upload failed'));
  const view = render(<ChatPanel {...props()} />);
  const composer = view.container.querySelector<HTMLElement>('.composer');
  if (!composer) throw new Error('Composer missing');
  const file = new File(['docx'], 'paper.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });
  await waitFor(() =>
    expect(within(composer).queryByRole('button', { name: 'Download paper.docx' })).toBeNull(),
  );
  expect(transport.startTurn).not.toHaveBeenCalled();
  expect(screen.getByText(/Could not upload paper\.docx: Upload failed/)).toBeTruthy();
});

it('shows upload progress and blocks sending until the attachment is ready', async () => {
  let finish:
    | ((value: { id: string; name: string; mimeType: string; size: number }) => void)
    | undefined;
  transport.uploadAttachment.mockImplementation((_id, _file, _signal, onProgress) => {
    onProgress?.(47);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const view = render(<ChatPanel {...props()} />);
  const file = new File(['text'], 'notes.md', { type: 'text/markdown' });
  fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });
  await waitFor(() =>
    expect(
      screen.getByRole('progressbar', { name: 'Uploading notes.md' }).getAttribute('value'),
    ).toBe('47'),
  );
  expect(screen.getByRole('button', { name: 'Send message' }).getAttribute('aria-disabled')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(transport.startTurn).not.toHaveBeenCalled();
  expect(track).toHaveBeenCalledWith('action_blocked', {
    action: 'send_message',
    failure_code: 'upload_in_progress',
  });
  finish?.({ id: 'uploaded', name: file.name, mimeType: file.type, size: file.size });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  view.unmount();
});
