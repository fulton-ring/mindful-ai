// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnnotationEvent, ChatEvent, Conversation } from '@walden/contracts';
import { expect, it, vi } from 'vitest';
import { conversation, getTransport, props } from '../../_ChatPanel.test-helpers';
import { ChatPanel } from '../../ChatPanel';

const transport = getTransport();

it('clears the response deadline on unmount even when the transport does not settle', async () => {
  const schedule = vi.spyOn(window, 'setTimeout');
  const clear = vi.spyOn(window, 'clearTimeout');
  transport.streamChat.mockImplementation(() => new Promise(() => {}));
  try {
    const rendered = render(<ChatPanel {...props()} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(transport.streamChat).toHaveBeenCalled());
    const index = schedule.mock.calls.findIndex((call) => call[1] === 315_000);
    expect(index).toBeGreaterThanOrEqual(0);
    const deadline = schedule.mock.results[index]?.value;
    rendered.unmount();
    expect(clear).toHaveBeenCalledWith(deadline);
  } finally {
    schedule.mockRestore();
    clear.mockRestore();
  }
});

it('preserves a saved removal when a late classifier result updates the message', async () => {
  const message = {
    id: 'highlight-source',
    role: 'assistant' as const,
    content: 'Ice floats.',
    createdAt: new Date().toISOString(),
  };
  const history = { ...conversation('conversation-1'), messages: [message] };
  const values = props(history);
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
      annotations: [{ id: 'late', quote: message.content, kind: 'fact', whose: 'assistant' }],
    });
    finish?.();
  });
  const updated = values.onConversation.mock.calls.at(-1)?.[0].messages[0];
  expect(updated?.annotations).toHaveLength(1);
  expect(updated?.highlights).toEqual([
    { start: 0, end: 11, quote: message.content, color: null, origin: 'user' },
  ]);
});
it('stops following when the reader scrolls slightly up and resumes only at the bottom', async () => {
  let emit: ((event: ChatEvent) => void) | undefined;
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    emit = onEvent;
    return new Promise<void>(() => undefined);
  });
  const view = render(<ChatPanel {...props()} />);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(emit).toBeTypeOf('function'));
  const scroll = view.container.querySelector('.chat-scroll')!;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: 760 },
  });
  fireEvent.wheel(scroll, { deltaY: -40 });
  fireEvent.scroll(scroll);
  vi.mocked(HTMLElement.prototype.scrollTo).mockClear();
  act(() => emit?.({ type: 'text', text: 'More text' }));
  expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  scroll.scrollTop = 800;
  fireEvent.scroll(scroll);
  act(() => emit?.({ type: 'text', text: ' continues' }));
  expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
    top: 1000,
    behavior: 'instant',
  });
});

it('catches up a long streamed response without waiting on the old speed cap', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let emit: ((event: ChatEvent) => void) | undefined;
  const text = 'x'.repeat(5000);
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    emit = onEvent;
    return new Promise<void>(() => undefined);
  });
  const view = render(<ChatPanel {...props()} />);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(emit).toBeTypeOf('function'));
  act(() => emit?.({ type: 'text', text }));
  expect(frames).toHaveLength(1);
  act(() => frames.shift()?.(0));
  const firstFrame =
    view.container.querySelector('[data-annotation-count]')?.firstChild?.textContent ?? '';
  expect(firstFrame.length).toBeGreaterThan(0);
  expect(firstFrame.length).toBeLessThan(text.length);
  for (let timestamp = 16; timestamp <= 1000 && frames.length; timestamp += 16)
    act(() => frames.shift()?.(timestamp));
  const oneSecond =
    view.container.querySelector('[data-annotation-count]')?.firstChild?.textContent ?? '';
  expect(oneSecond.length).toBeGreaterThan(text.length * 0.99);
  for (let timestamp = 1016; timestamp <= 2000 && frames.length; timestamp += 16)
    act(() => frames.shift()?.(timestamp));
  expect(view.container.querySelector('[data-annotation-count]')?.firstChild?.textContent).toBe(
    text,
  );
});

it('finalizes buffered response text before allowing the next message', async () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const text = 'A completed answer. '.repeat(100);
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text });
    onEvent({
      type: 'done',
      message: {
        id: 'buffered-answer',
        role: 'assistant',
        content: text,
        createdAt: new Date().toISOString(),
      },
      title: 'Conversation',
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      expiresAt: '2026-09-25T00:00:00.000Z',
      annotationsHandled: true,
    });
  });
  const values = props();
  render(<ChatPanel {...values} />);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(screen.queryByLabelText('Stop response')).toBeNull());
  expect(values.onConversation).toHaveBeenCalledWith(
    expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'buffered-answer', content: text }),
      ]),
    }),
  );
});

it('does not persist a buffered completion when stop wins before drain', async () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text: 'Partial answer' });
    onEvent({
      type: 'done',
      message: {
        id: 'buffered-done',
        role: 'assistant',
        content: 'Completed answer',
        createdAt: new Date().toISOString(),
      },
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      title: 'Conversation',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
    return new Promise<void>(() => undefined);
  });
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(screen.getByLabelText('Stop response')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('Stop response'));

  expect(values.onConversation).toHaveBeenCalledTimes(1);
  expect(values.onConversation.mock.calls[0]?.[0].messages).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'buffered-done' })]),
  );
  expect(screen.getByText('Incomplete response')).toBeTruthy();
});
it('uses the first available persona when the built-in default is unavailable', async () => {
  transport.streamChat.mockReturnValue(new Promise(() => undefined));
  const values = props();
  const custom = {
    id: 'custom-only',
    name: 'Custom coach',
    prompt: 'Help clearly.',
    brevity: 'brief' as const,
    challenge: 'balanced' as const,
    tone: 'neutral' as const,
    revision: 1,
  };
  render(<ChatPanel {...values} personas={[custom]} />);

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));

  await waitFor(() => expect(transport.streamChat).toHaveBeenCalledTimes(1));
  expect(transport.streamChat.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ personaId: 'custom-only' }),
  );
});

it('keeps the first turn alive when its newly created conversation route is adopted', async () => {
  let finishEnsure: ((value: Conversation) => void) | undefined;
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text: 'Visible first token' });
    return new Promise<void>(() => undefined);
  });
  const created = conversation('conversation-created');
  const values = props(created);
  values.onEnsureConversation.mockReturnValue(
    new Promise<Conversation>((resolve) => {
      finishEnsure = resolve;
    }),
  );
  const rendered = render(<ChatPanel {...values} conversation={null} scopeId={null} />);

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'First question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(values.onEnsureConversation).toHaveBeenCalledTimes(1));
  rendered.rerender(<ChatPanel {...values} conversation={created} scopeId={created.id} />);
  finishEnsure?.(created);

  expect(await screen.findByText('Visible first token')).toBeTruthy();
  expect(transport.cancelTurn).not.toHaveBeenCalled();
});

it('switches to the full-height conversation layout as soon as submit begins', async () => {
  const values = props();
  values.onFlush.mockReturnValue(new Promise<null>(() => undefined));
  render(<ChatPanel {...values} />);

  expect(screen.getByLabelText('Thread').classList).toContain('empty-conversation');
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));

  expect(screen.getByLabelText('Thread').classList).not.toContain('empty-conversation');
  expect(screen.getByText('Question')).toBeTruthy();
  expect(screen.getByText('Preparing…')).toBeTruthy();
  expect(transport.streamChat).not.toHaveBeenCalled();
});

it('keeps interrupted text visible, unlocks the composer, and ignores late completion', async () => {
  let emit: ((event: ChatEvent) => void) | undefined;
  let finishFirst: (() => void) | undefined;
  let call = 0;
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    call += 1;
    if (call > 1) return new Promise<void>(() => undefined);
    emit = onEvent;
    onEvent({ type: 'text', text: 'Partial answer' });
    await new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
  });
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await screen.findByText('Partial answer');
  fireEvent.click(screen.getByLabelText('Stop response'));

  expect(await screen.findByText('Incomplete response')).toBeTruthy();
  expect(screen.getByLabelText('Send message')).toBeTruthy();
  emit?.({
    type: 'done',
    message: {
      id: 'late',
      role: 'assistant',
      content: 'Late answer',
      createdAt: new Date().toISOString(),
    },
    conversationId: 'conversation-1',
    branchId: 'branch-1',
    title: 'Conversation',
    expiresAt: '2026-09-25T00:00:00.000Z',
  });
  expect(values.onConversation).toHaveBeenCalledTimes(1);
  expect(transport.messageAnnotations).not.toHaveBeenCalled();
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Next question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(transport.streamChat).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Question')).toBeTruthy();
  expect(screen.getByText('Partial answer')).toBeTruthy();
  expect(screen.getByText('Incomplete response')).toBeTruthy();
  finishFirst?.();
  await waitFor(() => expect(screen.getByLabelText('Stop response')).toBeTruthy());
});

it('waits for stop acknowledgement before starting another turn', async () => {
  let acknowledge: (() => void) | undefined;
  transport.cancelTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = () => resolve({ cancelled: true });
      }),
  );
  transport.streamChat.mockImplementation(() => new Promise(() => {}));
  render(<ChatPanel {...props()} />);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'First' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(transport.streamChat).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Stop response'));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Second' } });
  await act(async () => fireEvent.click(screen.getByLabelText('Send message')));
  expect(transport.streamChat).toHaveBeenCalledTimes(1);
  await act(async () => acknowledge?.());
  await waitFor(() => expect(transport.streamChat).toHaveBeenCalledTimes(2));
});

it('offers recovery immediately when stopped before the first token', async () => {
  transport.streamChat.mockImplementation(() => new Promise<void>(() => undefined));
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Keep this question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(transport.streamChat).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Stop response'));
  expect(await screen.findByText('No response received')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
  expect((screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value).toBe(
    'Keep this question',
  );
  expect(transport.streamChat).toHaveBeenCalledTimes(1);
  expect(transport.cancelTurn).toHaveBeenCalledTimes(1);
});

it('restores the latest failed question without sending or overwriting a draft', () => {
  const values = props();
  values.conversation.messages = [
    { id: 'question', role: 'user', content: 'Original question', createdAt: '' },
    { id: 'failed', role: 'assistant', content: '', incomplete: true, createdAt: '' },
  ];
  render(<ChatPanel {...values} />);
  expect(screen.getByText('No response received')).toBeTruthy();
  const composer = screen.getByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: 'Unsent draft' } });
  const retry = screen.getByRole('button', { name: 'Edit message' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  fireEvent.click(retry);
  expect(composer.value).toBe('Unsent draft');
  fireEvent.change(composer, { target: { value: '' } });
  fireEvent.click(retry);
  expect((screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value).toBe(
    'Original question',
  );
  expect(transport.streamChat).not.toHaveBeenCalled();
});

it('adopts a partial response as incomplete when the stream reports an error', async () => {
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text: 'Partial output' });
    onEvent({ type: 'reasoning', text: 'Reasoning retained' });
    onEvent({
      type: 'tool',
      tool: {
        id: 'tool-1',
        name: 'searchSources',
        state: 'complete',
        summary: 'Sources searched',
      },
    });
    onEvent({
      type: 'source',
      source: { id: 'source-1', url: 'https://example.com/source' },
    });
    onEvent({
      type: 'error',
      message: 'The response reached its output limit. Please try again.',
      partialMessage: {
        id: 'persisted-partial',
        role: 'assistant',
        content: 'Full persisted partial output',
        reasoning: 'Reasoning retained',
        tools: [
          { id: 'tool-1', name: 'searchSources', state: 'complete', summary: 'Sources searched' },
        ],
        sources: [{ id: 'source-1', url: 'https://example.com/source' }],
        contextCompacted: true,
        createdAt: new Date().toISOString(),
        incomplete: true,
      },
    });
  });
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));
  await waitFor(() => expect(values.onConversation).toHaveBeenCalledTimes(1));
  const adopted = values.onConversation.mock.calls[0]?.[0] as Conversation;
  expect(adopted.messages.at(-1)).toMatchObject({
    id: 'persisted-partial',
    role: 'assistant',
    content: 'Full persisted partial output',
    incomplete: true,
    reasoning: 'Reasoning retained',
    contextCompacted: true,
    tools: [{ id: 'tool-1' }],
    sources: [{ id: 'source-1' }],
  });
  expect(screen.getByText('Full persisted partial output')).toBeTruthy();
  expect(screen.getAllByText('Full persisted partial output')).toHaveLength(1);
  expect(screen.getByText('Incomplete response')).toBeTruthy();
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();
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
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));

  const second = props(conversation('conversation-2'));
  rendered.rerender(<ChatPanel {...second} />);
  finishFlush?.(null);

  await waitFor(() => expect(transport.streamChat).not.toHaveBeenCalled());
  expect(screen.getByLabelText('Send message')).toBeTruthy();
});

it('keeps the streamed response visible until saved message adoption', async () => {
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({
      type: 'done',
      message: {
        id: 'assistant-complete',
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
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
  fireEvent.click(screen.getByLabelText('Send message'));

  const liveArticle = await waitFor(() => screen.getByText('Completed answer').closest('article'));
  expect(liveArticle).not.toBeNull();
  const finalized = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
  rendered.rerender(<ChatPanel {...values} conversation={finalized} />);

  expect(screen.getAllByText('Completed answer')).toHaveLength(1);
  expect(screen.getByText('Completed answer').closest('article')).toBe(liveArticle);
  rendered.unmount();
  expect(transport.cancelTurn).not.toHaveBeenCalled();
});
