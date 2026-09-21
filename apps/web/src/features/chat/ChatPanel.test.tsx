// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  Annotation,
  AnnotationEvent,
  ChatEvent,
  Conversation,
  MessageHighlight,
  NoteProposalEvent,
} from '@walden/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';

const transport = vi.hoisted(() => ({
  setWebSearch: vi.fn(),
  setLearningChecks: vi.fn(),
  cancelTurn: vi.fn().mockResolvedValue({ cancelled: true }),
  cancelNoteProposal: vi.fn().mockResolvedValue({ cancelledSuggestionIds: [], noteState: null }),
  messageAnnotations: vi.fn(),
  saveHighlight: vi.fn(),
  streamChat: vi.fn(),
  streamMessageAnnotations: vi.fn(),
  streamNoteProposal: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    setWebSearch: transport.setWebSearch,
    setLearningChecks: transport.setLearningChecks,
    cancelTurn: transport.cancelTurn,
    cancelNoteProposal: transport.cancelNoteProposal,
    messageAnnotations: transport.messageAnnotations,
    saveHighlight: transport.saveHighlight,
  },
  streamChat: transport.streamChat,
  streamMessageAnnotations: transport.streamMessageAnnotations,
  streamNoteProposal: transport.streamNoteProposal,
}));
vi.mock('../../lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('../highlights/AnnotatedText', () => ({
  AnnotatedText: ({
    text,
    annotations,
    onAction,
    onHighlight,
    actionStatus,
  }: {
    text: string;
    annotations?: Annotation[];
    onAction(action: 'capture', quote: string): void;
    onHighlight?(value: MessageHighlight): Promise<void>;
    actionStatus?: {
      pending: boolean;
      message?: string;
      alert?: boolean;
      onRetry?(): void;
      onDismiss?(): void;
    } | null;
  }) => (
    <div data-annotation-count={annotations?.length ?? 0}>
      {text}
      {/* A capture reports back into the selection menu, so the double shows it
          the way the real one does. */}
      {actionStatus?.pending && <span>Adding to note…</span>}
      {actionStatus && !actionStatus.pending && actionStatus.message && (
        <span role={actionStatus.alert ? 'alert' : 'status'}>{actionStatus.message}</span>
      )}
      {actionStatus?.onRetry && !actionStatus.pending && (
        <button type="button" onClick={actionStatus.onRetry}>
          Retry note proposal
        </button>
      )}
      {actionStatus?.onDismiss && !actionStatus.pending && (
        <button type="button" onClick={actionStatus.onDismiss}>
          Dismiss note error
        </button>
      )}
      {onHighlight && (
        <button
          type="button"
          onClick={() =>
            void onHighlight({
              start: 0,
              end: text.length,
              quote: text,
              color: null,
              origin: 'user',
            })
          }
        >
          Remove highlight
        </button>
      )}
      {text && (
        <button type="button" onClick={() => onAction('capture', text)}>
          Add selection to note
        </button>
      )}
    </div>
  ),
}));
vi.mock('../personas/PersonaPicker', () => ({
  PersonaPicker: () => null,
  effectivePersona: (personas: Array<{ id: string }>, value: string) =>
    personas.find((persona) => persona.id === value) ??
    personas.find((persona) => persona.id === 'thinking-partner') ??
    personas[0],
}));
vi.mock('../capture/InterventionCard', () => ({
  InterventionCard: ({ onCapture }: { onCapture(value: string, verbatim: boolean): void }) => (
    <button type="button" onClick={() => onCapture('Intervention exact text', true)}>
      Capture intervention
    </button>
  ),
}));
vi.mock('../../components/ai-elements/reasoning', () => ({
  Reasoning: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ReasoningContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ReasoningTrigger: () => null,
}));

const conversation = (id: string): Conversation => ({
  id,
  branchId: 'branch-1',
  branches: [
    {
      id: 'branch-1',
      forkedFromMessageId: null,
      headMessageId: null,
      expiresAt: '2026-09-25T00:00:00.000Z',
    },
  ],
  title: 'Conversation',
  noteId: null,
  messages: [],
  expiresAt: '2026-09-25T00:00:00.000Z',
  learningChecksEnabled: false,
});

function props(value = conversation('conversation-1')) {
  return {
    conversation: value,
    scopeId: value.id,
    personas: [],
    personaId: '',
    noteOpen: true,
    onPersona: vi.fn(),
    onOpenNote: vi.fn(),
    onEnsureConversation: vi.fn().mockResolvedValue(value),
    onConversation: vi.fn(),
    onFlush: vi.fn().mockResolvedValue(null),
    onProposalStart: vi.fn(),
    onProposalCancelable: vi.fn(),
    onGhost: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.streamMessageAnnotations.mockImplementation(
    async (
      messageId: string,
      input: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal,
    ) => {
      const annotations = await transport.messageAnnotations(messageId, input, signal);
      onEvent({ type: 'done', annotations });
    },
  );
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatPanel cancellation', () => {
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
    expect(
      (screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value,
    ).toBe('Keep this question');
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
    expect(
      (screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value,
    ).toBe('Original question');
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

describe('ChatPanel annotation recovery', () => {
  it('shows primary-stream highlights before completion without classifying twice', async () => {
    let emit: ((event: ChatEvent) => void) | undefined;
    let finish: (() => void) | undefined;
    transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
      emit = onEvent;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    transport.streamNoteProposal.mockResolvedValue(undefined);
    const values = props();
    const rendered = render(<ChatPanel {...values} />);
    values.onConversation.mockImplementation((next: Conversation) => {
      rendered.rerender(<ChatPanel {...values} conversation={next} />);
    });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(emit).toBeTypeOf('function'));
    const annotation: Annotation = {
      id: 'early',
      quote: 'Ice floats.',
      kind: 'fact',
      whose: 'assistant',
    };
    act(() => {
      emit?.({ type: 'text', text: 'Ice floats.' });
      emit?.({ type: 'annotation', annotation });
    });
    expect(screen.getByText('Ice floats.').getAttribute('data-annotation-count')).toBe('1');
    expect(transport.streamNoteProposal).not.toHaveBeenCalled();
    await act(async () => {
      emit?.({
        type: 'done',
        annotationsHandled: true,
        message: {
          id: 'early-answer',
          role: 'assistant',
          content: 'Ice floats.',
          annotations: [annotation],
          createdAt: new Date().toISOString(),
        },
        conversationId: values.conversation.id,
        branchId: values.conversation.branchId,
        title: values.conversation.title,
        expiresAt: values.conversation.expiresAt,
      });
      finish?.();
    });
    expect(screen.getByText('Ice floats.').getAttribute('data-annotation-count')).toBe('1');
    expect(transport.streamMessageAnnotations).not.toHaveBeenCalled();
    // Nothing asks for a note here, so none is proposed.
    expect(transport.streamNoteProposal).not.toHaveBeenCalled();
  });

  it('keeps streamed highlights when the terminal classifier result is incomplete', async () => {
    transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
      onEvent({
        type: 'done',
        message: {
          id: 'assistant-highlights',
          role: 'assistant',
          content: 'Ice floats. Water freezes.',
          createdAt: new Date().toISOString(),
        },
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        title: 'Conversation',
        expiresAt: '2026-09-25T00:00:00.000Z',
      });
    });
    transport.streamNoteProposal.mockResolvedValue(undefined);
    transport.streamMessageAnnotations.mockImplementation(
      async (_id, _input, onEvent: (event: AnnotationEvent) => void) => {
        onEvent({
          type: 'annotation',
          annotation: { id: 'ice', quote: 'Ice floats.', kind: 'fact', whose: 'assistant' },
        });
        onEvent({
          type: 'done',
          annotations: [{ id: 'water', quote: 'Water freezes.', kind: 'fact', whose: 'assistant' }],
        });
      },
    );
    const values = props();
    const rendered = render(<ChatPanel {...values} />);
    values.onConversation.mockImplementation((next: Conversation) => {
      rendered.rerender(<ChatPanel {...values} conversation={next} />);
    });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() =>
      expect(
        screen.getByText('Ice floats. Water freezes.').getAttribute('data-annotation-count'),
      ).toBe('2'),
    );
  });

  it('aborts a streaming note proposal and ignores a late terminal event', async () => {
    let emitProposal: ((event: unknown) => void) | undefined;
    let proposalSignal: AbortSignal | undefined;
    transport.messageAnnotations.mockResolvedValue([]);
    transport.streamNoteProposal.mockImplementation(
      async (_messageId, _input, onEvent: (event: unknown) => void, signal: AbortSignal) => {
        emitProposal = onEvent;
        proposalSignal = signal;
        return new Promise<void>(() => undefined);
      },
    );
    transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
      onEvent({
        type: 'done',
        message: {
          id: 'assistant-proposal',
          role: 'assistant',
          content: 'Response',
          createdAt: new Date().toISOString(),
        },
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        title: 'Thread',
        expiresAt: '2026-09-25T00:00:00.000Z',
      });
    });
    const values = props();
    const rendered = render(<ChatPanel {...values} />);
    values.onConversation.mockImplementation((next: Conversation) => {
      rendered.rerender(<ChatPanel {...values} conversation={next} />);
    });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Question' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    // Note suggestions are asked for, never automatic.
    await screen.findByRole('button', { name: 'Add selection to note' });
    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
    await waitFor(() => expect(emitProposal).toBeTypeOf('function'));
    emitProposal?.({
      type: 'preview',
      proposal: {
        id: 'proposal-attempt:1',
        noteId: 'note-1',
        baseRevision: 1,
        oldText: '',
        newText: 'Preview',
        reason: 'Preview',
        status: 'pending',
      },
    });
    const cancel = [...values.onProposalCancelable.mock.calls]
      .reverse()
      .find((call) => call[0])?.[0];

    let pendingCancel: Promise<unknown> | undefined;
    await act(async () => {
      pendingCancel = cancel?.();
    });
    rendered.rerender(
      <ChatPanel {...values} conversation={{ ...values.conversation!, branchId: 'branch-2' }} />,
    );
    await act(async () => {
      await pendingCancel;
    });
    expect(proposalSignal?.aborted).toBe(true);
    expect(transport.cancelNoteProposal).toHaveBeenCalledWith('assistant-proposal', {
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      attemptId: 'proposal-attempt',
    });
    emitProposal?.({
      type: 'done',
      proposal: {
        id: 'late-proposal',
        noteId: 'note-1',
        baseRevision: 1,
        oldText: '',
        newText: 'Late',
        reason: 'Late',
        status: 'pending',
      },
    });

    expect(values.onGhost).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'late-proposal' }),
      false,
      expect.any(String),
    );
    expect(values.onGhost).toHaveBeenLastCalledWith(null, false, expect.any(String));
  });

  it.each(['event', 'transport'])('reports a failed note proposal via %s', async (failure) => {
    const message = 'The note suggestion could not be completed as a concise, safe edit.';
    transport.streamNoteProposal.mockImplementation(async (_id, _input, onEvent) => {
      if (failure === 'transport') throw new Error(message);
      onEvent({ type: 'error', message });
    });
    const values = props({
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'reply',
          role: 'assistant',
          content: 'An answer',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPanel {...values} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
    const notice = await screen.findByText(message);
    expect(notice.closest('article')?.textContent).toContain('An answer');
    expect(screen.getByRole('button', { name: 'Retry note proposal' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss note error' }));
    expect(screen.queryByText(message)).toBeNull();
    expect(values.onGhost).toHaveBeenCalledWith(null, false, expect.any(String));
  });

  it('retries a failed note proposal from the response that owns the error', async () => {
    transport.streamNoteProposal
      .mockRejectedValueOnce(new Error('Proposal unavailable'))
      .mockImplementationOnce(async (_id, _input, onEvent) => {
        onEvent({ type: 'done', proposal: null });
      });
    const values = props({
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'reply',
          role: 'assistant',
          content: 'An answer',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPanel {...values} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
    await screen.findByText('Proposal unavailable');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Add selection to note' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry note proposal' }));

    await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(2));
    expect(transport.streamNoteProposal.mock.calls[1]?.[0]).toBe('reply');
  });

  it('never proposes a note on its own when a response completes', async () => {
    transport.messageAnnotations.mockReturnValue(new Promise(() => undefined));
    transport.streamNoteProposal.mockImplementation(
      async (_messageId, _input, onEvent: (event: NoteProposalEvent) => void) => {
        onEvent({ type: 'done', proposal: null });
      },
    );
    transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
      onEvent({
        type: 'done',
        message: {
          id: 'assistant-auto-proposal',
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
    values.onConversation.mockImplementation((next: Conversation) => {
      rendered.rerender(<ChatPanel {...values} conversation={next} />);
    });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Help me think' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    // Highlights still run on their own; note suggestions are only ever asked
    // for, so a completed answer with nothing worth keeping hands the reader
    // nothing to accept or reject.
    await waitFor(() => expect(transport.streamMessageAnnotations).toHaveBeenCalledTimes(1));
    expect(transport.streamNoteProposal).not.toHaveBeenCalled();
  });

  it('keeps a visible note suggestion alive while the next message starts', async () => {
    let proposalSignal: AbortSignal | undefined;
    let call = 0;
    transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
      call += 1;
      if (call === 1) {
        onEvent({
          type: 'done',
          message: {
            id: 'assistant-first-note',
            role: 'assistant',
            content: 'First answer',
            createdAt: new Date().toISOString(),
          },
          conversationId: 'conversation-1',
          branchId: 'branch-1',
          title: 'Conversation',
          expiresAt: '2026-09-25T00:00:00.000Z',
        });
        return;
      }
      return new Promise<void>(() => undefined);
    });
    transport.streamNoteProposal.mockImplementation(
      async (_id, _input, _onEvent, signal: AbortSignal) => {
        proposalSignal = signal;
        return new Promise<void>(() => undefined);
      },
    );
    const values = props();
    const rendered = render(<ChatPanel {...values} />);
    values.onConversation.mockImplementation((next: Conversation) => {
      rendered.rerender(<ChatPanel {...values} conversation={next} />);
    });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'First' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await screen.findByRole('button', { name: 'Add selection to note' });
    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
    await waitFor(() => expect(proposalSignal).toBeDefined());
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(proposalSignal?.aborted).toBe(false);
  });

  it('offers a selection capture on any completed response while keeping other response actions', async () => {
    transport.messageAnnotations.mockResolvedValue([]);
    transport.streamNoteProposal.mockReturnValue(new Promise(() => undefined));
    const history = {
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-old',
          role: 'assistant' as const,
          content: 'Old response',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'assistant-latest',
          role: 'assistant' as const,
          content: '**Latest response**',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    render(<ChatPanel {...props(history)} />);

    const proposeButtons = screen.getAllByRole('button', { name: 'Add selection to note' });
    expect((proposeButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((proposeButtons[1] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(proposeButtons[0]!);
    fireEvent.click(proposeButtons[0]!);
    await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(1));
    expect(transport.streamNoteProposal.mock.calls[0]?.[0]).toBe('assistant-old');
    expect(transport.streamNoteProposal.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ noteProposalRequested: true }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Highlight response' })[0]!);
    await waitFor(() => expect(transport.streamMessageAnnotations).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy response' })[1]!);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('**Latest response**'),
    );
  });

  it('finishes a note proposal whose stream ends without a terminal event', async () => {
    // The proposal stream can close after its previews without a done or an
    // error. Nothing then told the editor the stream was over, so it stayed on
    // "Suggesting…" with accepting disabled until the page was reloaded.
    const preview = {
      id: 'proposal-stranded',
      noteId: 'note-1',
      baseRevision: 1,
      oldText: '',
      newText: 'Index funds spread risk.',
      reason: 'capture',
      status: 'pending' as const,
    };
    transport.streamNoteProposal.mockImplementation(async (_id, _input, onEvent) => {
      onEvent({ type: 'preview', proposal: preview, operationIndex: 0 });
      // and the stream simply ends
    });
    const onGhostBatch = vi.fn();
    const values = props({
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-stranded',
          role: 'assistant' as const,
          content: 'Selected exact text',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPanel {...values} onGhostBatch={onGhostBatch} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));

    // Completed with what arrived, rather than left open forever.
    await waitFor(() => expect(onGhostBatch).toHaveBeenCalledTimes(1));
    expect(onGhostBatch).toHaveBeenCalledWith([preview], expect.any(String));
  });

  it('finishes a note proposal whose stream ends having produced nothing', async () => {
    transport.streamNoteProposal.mockImplementation(async () => {
      // no events at all
    });
    const values = props({
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-empty',
          role: 'assistant' as const,
          content: 'Selected exact text',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPanel {...values} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));

    await waitFor(() =>
      expect(values.onGhost).toHaveBeenCalledWith(null, false, expect.any(String)),
    );
  });

  it('reports a declined Add to note in the selection menu, not under the response', async () => {
    // Declining is the ordinary outcome of "Add to note" — the point is usually
    // already in the note. Reporting it under the response sent the reader
    // looking somewhere they were not.
    transport.streamNoteProposal.mockImplementation(async (_id, _input, onEvent) => {
      onEvent({
        type: 'done',
        proposal: null,
        reason: 'The information is already covered by the response.',
      });
    });
    const values = props({
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-declined',
          role: 'assistant' as const,
          content: 'Selected exact text',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPanel {...values} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));

    await screen.findByText('The information is already covered by the response.');
    // The menu's own dismiss, not the one under the response.
    expect(screen.getByRole('button', { name: 'Dismiss note error' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss note proposal status' })).toBeNull();
  });

  it('routes Add to note through the streamed proposal pipeline, leaving it pending', async () => {
    transport.streamNoteProposal.mockResolvedValue(undefined);
    const history = {
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant' as const,
          content: 'Selected exact text',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const values = props(history);
    render(<ChatPanel {...values} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));

    await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(1));
    expect(transport.streamNoteProposal).toHaveBeenCalledWith(
      'assistant-1',
      expect.objectContaining({
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        noteProposalRequested: true,
        action: 'capture',
        captureText: 'Selected exact text',
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    // No second argument: a capture is a proposal the reader still has to
    // accept, exactly like one made from a whole response.
    expect(values.onProposalStart).toHaveBeenCalledWith(expect.any(String));
    expect(values.onOpenNote).toHaveBeenCalledOnce();
  });

  it('offers a manual note proposal for a completed reply', async () => {
    transport.streamNoteProposal.mockResolvedValue(undefined);
    const history = {
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant' as const,
          content: 'Change the term in the note.',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    render(<ChatPanel {...props(history)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Propose note edit' }));

    await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledOnce());
    expect(transport.streamNoteProposal).toHaveBeenCalledWith(
      'assistant-1',
      expect.objectContaining({ noteProposalRequested: true }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it('delivers every streamed preview and hydrates a terminal proposal batch once', async () => {
    const first = {
      id: 'proposal-first',
      noteId: 'note-1',
      baseRevision: 1,
      oldText: 'A',
      newText: 'A and B',
      reason: 'first operation',
      status: 'pending' as const,
    };
    const second = { ...first, id: 'proposal-second', oldText: 'C', newText: 'C and D' };
    transport.streamNoteProposal.mockImplementation(async (_id, _input, onEvent) => {
      onEvent({ type: 'preview', proposal: first, operationIndex: 0 });
      onEvent({ type: 'preview', proposal: second, operationIndex: 1 });
      onEvent({ type: 'done', proposal: second, proposals: [first, second] });
    });
    const onGhostBatch = vi.fn();
    const values = props({
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-batch-source',
          role: 'assistant' as const,
          content: 'A C',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPanel {...values} onGhostBatch={onGhostBatch} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));

    await waitFor(() => expect(onGhostBatch).toHaveBeenCalledTimes(1));
    expect(values.onGhost).toHaveBeenCalledWith(first, true, expect.any(String));
    expect(values.onGhost).toHaveBeenCalledWith(second, true, expect.any(String));
    expect(onGhostBatch).toHaveBeenCalledWith([first, second], expect.any(String));
    expect(values.onGhost).not.toHaveBeenCalledWith(second, false, expect.any(String));
  });

  it('preserves capture text when retrying a failed Add to note', async () => {
    transport.streamNoteProposal
      .mockImplementationOnce(async (_id, _input, onEvent) => {
        onEvent({ type: 'error', message: 'Proposal unavailable' });
      })
      .mockImplementationOnce(async (_id, _input, onEvent) => {
        onEvent({ type: 'done', proposal: null });
      });
    const values = props({
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-capture-retry',
          role: 'assistant' as const,
          content: 'Selected exact text',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(<ChatPanel {...values} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
    await screen.findByText('Proposal unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry note proposal' }));

    await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(2));
    expect(transport.streamNoteProposal.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ action: 'capture', captureText: 'Selected exact text' }),
    );
    expect(values.onProposalStart).toHaveBeenLastCalledWith(expect.any(String));
  });

  it('routes intervention capture through the same streamed proposal pipeline', async () => {
    transport.streamChat.mockImplementation(async (_input, onEvent) => {
      onEvent({
        type: 'intervention',
        intervention: {
          id: 'intervention-1',
          kind: 'ask',
          question: 'Keep this?',
          options: ['Intervention exact text'],
        },
      });
    });
    transport.streamNoteProposal.mockResolvedValue(undefined);
    const history = {
      ...conversation('conversation-1'),
      messages: [
        {
          id: 'assistant-source',
          role: 'assistant' as const,
          content: 'Earlier completed response',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const values = props(history);
    render(<ChatPanel {...values} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Continue' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Capture intervention' })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Capture intervention' }));

    await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(1));
    expect(transport.streamNoteProposal).toHaveBeenCalledWith(
      'assistant-source',
      expect.objectContaining({
        action: 'capture',
        captureText: 'Intervention exact text',
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(values.onProposalStart).toHaveBeenCalledWith(expect.any(String));
  });

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
    const history = {
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

  it.each(['before', 'after'] as const)(
    'preserves prior-turn annotations that resolve %s the next turn completes',
    async (order) => {
      let finishFirstAnnotations: ((value: unknown[]) => void) | undefined;
      transport.messageAnnotations
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishFirstAnnotations = resolve;
          }),
        )
        .mockReturnValue(new Promise(() => undefined));
      let emitSecond: ((event: ChatEvent) => void) | undefined;
      let turn = 0;
      transport.streamChat.mockImplementation(
        async (_input, onEvent: (event: ChatEvent) => void) => {
          turn += 1;
          if (turn === 1) {
            onEvent({
              type: 'done',
              message: {
                id: 'assistant-first',
                role: 'assistant',
                content: 'First answer',
                createdAt: new Date().toISOString(),
              },
              conversationId: 'conversation-1',
              branchId: 'branch-1',
              title: 'Conversation',
              expiresAt: '2026-09-25T00:00:00.000Z',
            });
            return;
          }
          emitSecond = onEvent;
          return new Promise<void>(() => undefined);
        },
      );
      transport.streamNoteProposal.mockImplementation(
        async (_messageId, _input, onEvent: (event: unknown) => void) => {
          onEvent({ type: 'done', proposal: null });
        },
      );
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
      await waitFor(() => expect(emitSecond).toBeTypeOf('function'));

      const annotation = {
        id: 'annotation-first',
        quote: 'First answer',
        kind: 'claim',
        whose: 'assistant',
      };
      const finishSecond = () =>
        emitSecond?.({
          type: 'done',
          message: {
            id: 'assistant-second',
            role: 'assistant',
            content: 'Second answer',
            createdAt: new Date().toISOString(),
          },
          conversationId: 'conversation-1',
          branchId: 'branch-1',
          title: 'Conversation',
          expiresAt: '2026-09-25T00:00:00.000Z',
        });
      if (order === 'before') {
        finishFirstAnnotations?.([annotation]);
        await waitFor(() =>
          expect(
            latest.messages.find((message) => message.id === 'assistant-first')?.annotations,
          ).toHaveLength(1),
        );
        finishSecond();
      } else {
        finishSecond();
        await screen.findByText('Second answer');
        finishFirstAnnotations?.([annotation]);
      }

      await waitFor(() => {
        expect(latest.messages).toHaveLength(4);
        expect(
          latest.messages.find((message) => message.id === 'assistant-first')?.annotations,
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
    expect(
      await screen.findByText('The AI service is busy. Please try again shortly.'),
    ).toBeTruthy();
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
});

describe('streamed response activity', () => {
  it('updates tools in place, exposes sources, and clears activity when switching threads', async () => {
    let emit: (event: ChatEvent) => void = () => undefined;
    transport.streamChat.mockImplementation((_input, onEvent) => {
      emit = onEvent;
      return new Promise(() => undefined);
    });
    const values = props();
    const view = render(<ChatPanel {...values} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Read a page' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(transport.streamChat).toHaveBeenCalledTimes(1));
    act(() => emit({ type: 'context-compacted' }));
    expect(screen.getByLabelText('Context compacted')).toBeTruthy();
    act(() =>
      emit({
        type: 'tool',
        tool: { id: 'call-1', name: 'readWebPage', state: 'running', summary: 'Reading page' },
      }),
    );
    // Open already, with no click: while the turn is running this panel is the
    // only progress the reader gets, and a collapsed one made a multi-second
    // tool call look like the app had stalled and then answered all at once.
    expect(screen.getByText('Read page')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.queryByText('Read page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    act(() => {
      emit({
        type: 'tool',
        tool: { id: 'call-1', name: 'readWebPage', state: 'complete', summary: 'Read example.com' },
      });
      emit({
        type: 'source',
        source: { id: 'source-1', url: 'https://example.com/', title: 'Example Domain' },
      });
    });
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Example Domain' }).getAttribute('href')).toBe(
      'https://example.com/',
    );
    const assistant = document.querySelector('article.message.assistant');
    expect(assistant).toBeTruthy();
    const activity = assistant?.querySelector('[aria-label="Response activity"]');
    const responseText = assistant?.querySelector(
      'article.message.assistant > div:not([aria-label])',
    );
    const sources = assistant?.querySelector('[aria-label="Response sources"]');
    expect(activity?.compareDocumentPosition(responseText as Node) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(responseText?.compareDocumentPosition(sources as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByRole('button', { name: '1 source' })).toBeTruthy();
    expect(activity?.contains(screen.getByRole('link', { name: 'Example Domain' }))).toBe(true);
    view.rerender(<ChatPanel {...props(conversation('conversation-2'))} />);
    expect(screen.queryByLabelText('Context compacted')).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Example Domain' })).toBeNull();
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

it('can enable and disable learning checks before any quiz without sending a message', async () => {
  const value = conversation('quiz-toggle');
  const callbacks = props(value);
  transport.setLearningChecks.mockImplementation(async (_id, enabled) => ({
    learningChecksEnabled: enabled,
  }));
  const view = render(<ChatPanel {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
  const toggle = screen.getByRole('checkbox', { name: 'Learning checks' });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(callbacks.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({ learningChecksEnabled: true }),
    ),
  );
  view.rerender(
    <ChatPanel {...callbacks} conversation={{ ...value, learningChecksEnabled: true }} />,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Learning checks' }));
  await waitFor(() =>
    expect(transport.setLearningChecks).toHaveBeenLastCalledWith(value.id, false),
  );
  expect(transport.streamChat).not.toHaveBeenCalled();
});

it('toggles web search without sending a message', async () => {
  const value = conversation('search-toggle');
  const callbacks = props(value);
  transport.setWebSearch.mockImplementation(async (_id, enabled) => ({
    webSearchEnabled: enabled,
  }));
  const view = render(<ChatPanel {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
  expect((screen.getByRole('checkbox', { name: 'Web search' }) as HTMLInputElement).checked).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Web search' }));
  await waitFor(() =>
    expect(callbacks.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({ webSearchEnabled: false }),
    ),
  );
  view.rerender(<ChatPanel {...callbacks} conversation={{ ...value, webSearchEnabled: false }} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Web search' }));
  await waitFor(() => expect(transport.setWebSearch).toHaveBeenLastCalledWith(value.id, true));
  expect(transport.streamChat).not.toHaveBeenCalled();
});
