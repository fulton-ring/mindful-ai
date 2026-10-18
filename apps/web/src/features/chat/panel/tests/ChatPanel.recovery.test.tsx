// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Conversation } from '@walden/contracts';
import { expect, it } from 'vitest';
import {
  assistantMessage,
  conversation,
  getTransport,
  hang,
  openTurn,
  props,
  replyChunks,
  setComposerValue,
  textOf,
  userMessage,
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

it('hydrates a newly admitted user before replaying a reply after an immediate reload', async () => {
  const transport = getTransport();
  const prior = [
    userMessage('prior-user', 'Earlier cancelled question'),
    assistantMessage('prior-turn', '', { status: 'interrupted' }),
  ];
  const initial = { ...conversation('conversation-1'), messages: prior };
  const question =
    'E2E reconnect check: Explain photosynthesis in three short numbered stages, one sentence per stage.';
  const canonicalUser = userMessage('admitted-user', question);
  transport.activeTurn.mockResolvedValue({
    turn: {
      id: 'recover-turn',
      requestId: 'recover-request',
      conversationId: initial.id,
      branchId: initial.branchId,
      userMessageId: 'admitted-user',
      userMessage: canonicalUser,
    },
  });
  // Active users are stored before the committed branch head advances to include them.
  transport.conversation.mockResolvedValue(initial);
  const stream = openTurn('recover-turn', { admit: false });
  const values = props(initial);
  const view = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) =>
    view.rerender(<ChatPanel {...values} conversation={next} />),
  );
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  expect(screen.getAllByText(question)).toHaveLength(1);
  expect(screen.getByLabelText('Stop response')).toBeTruthy();
  act(() => {
    stream.emit(...replyChunks('recover-turn', '1. Plants absorb light.'));
    stream.done();
  });
  await waitFor(() => expect(screen.getByText('1. Plants absorb light.')).toBeTruthy());
  expect(screen.getAllByText(question)).toHaveLength(1);
  await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
  const saved = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
  expect(saved.messages.map(({ id }) => id)).toEqual([
    'prior-user',
    'prior-turn',
    'admitted-user',
    'recover-turn',
  ]);
  expect(transport.conversation).toHaveBeenCalledWith(initial.id, initial.branchId);
  expect(saved.messages[2]).toEqual(canonicalUser);
  expect(transport.startTurn).not.toHaveBeenCalled();
});

it('resumes an edit with the canonical user and its attachments before streaming the reply', async () => {
  const transport = getTransport();
  const initial = {
    ...conversation('conversation-1'),
    messages: [
      userMessage('earlier-user', 'Earlier question'),
      assistantMessage('earlier-turn', 'Earlier answer'),
      userMessage('edited-user', 'Outdated question'),
      assistantMessage('cancelled-turn', '', { status: 'interrupted' }),
    ],
  };
  const canonicalUser = userMessage('edited-user', 'Canonical edited question', [
    {
      type: 'file',
      mediaType: 'text/plain',
      filename: 'reference.txt',
      url: '/api/attachments/reference',
    },
  ]);
  transport.activeTurn.mockResolvedValueOnce({
    turn: {
      id: 'recover-turn',
      requestId: 'recover-request',
      conversationId: initial.id,
      branchId: initial.branchId,
      userMessageId: canonicalUser.id,
      userMessage: canonicalUser,
      editMessageId: 'edited-user',
    },
  });
  const stream = openTurn('recover-turn', { admit: false });
  const values = props(initial);
  render(<ChatPanel {...values} />);
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  expect(screen.getByText('Canonical edited question')).toBeTruthy();
  expect(screen.queryByText('Outdated question')).toBeNull();
  act(() => {
    stream.emit(...replyChunks('recover-turn', 'Edited answer'));
    stream.done();
  });
  await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
  const saved = values.onConversation.mock.calls.at(-1)?.[0] as Conversation;
  expect(saved.messages.map(({ id }) => id)).toEqual([
    'earlier-user',
    'earlier-turn',
    'edited-user',
    'recover-turn',
  ]);
  expect(saved.messages[2]).toEqual(canonicalUser);
});

it('ignores recovery history that arrives after switching conversations', async () => {
  const transport = getTransport();
  const initial = conversation('conversation-1');
  const other = {
    ...conversation('conversation-2'),
    messages: [userMessage('other-user', 'Other thread')],
  };
  transport.activeTurn.mockResolvedValueOnce({
    turn: {
      id: 'recover-turn',
      requestId: 'recover-request',
      conversationId: initial.id,
      branchId: initial.branchId,
      userMessageId: 'admitted-user',
    },
  });
  let resolveHistory!: (value: Conversation) => void;
  transport.conversation.mockImplementation(
    () =>
      new Promise<Conversation>((resolve) => {
        resolveHistory = resolve;
      }),
  );
  const values = props(initial);
  const view = render(<ChatPanel {...values} />);
  await waitFor(() => expect(transport.conversation).toHaveBeenCalled());
  view.rerender(<ChatPanel {...values} conversation={other} scopeId={other.id} />);
  await act(async () =>
    resolveHistory({
      ...initial,
      messages: [userMessage('admitted-user', 'Stale recovered question')],
    }),
  );
  expect(screen.getByText('Other thread')).toBeTruthy();
  expect(screen.queryByText('Stale recovered question')).toBeNull();
  expect(transport.turnEvents).not.toHaveBeenCalled();
  expect(values.onConversation).not.toHaveBeenCalled();
});

it('waits for admission to identify its user before hydrating and attaching', async () => {
  const transport = getTransport();
  const initial = conversation('conversation-1');
  const turn = {
    id: 'recover-turn',
    requestId: 'recover-request',
    conversationId: initial.id,
    branchId: initial.branchId,
    userMessageId: 'admitted-user',
  };
  transport.activeTurn.mockResolvedValueOnce({ turn: { ...turn, userMessageId: null } });
  transport.activeTurn.mockResolvedValue({ turn });
  transport.conversation.mockResolvedValue({
    ...initial,
    messages: [userMessage('admitted-user', 'Admitted question')],
  });
  openTurn(turn.id, { admit: false });
  render(<ChatPanel {...props(initial)} />);
  await waitFor(() => expect(transport.activeTurn).toHaveBeenCalledTimes(1));
  expect(transport.turnEvents).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText('Admitted question')).toBeTruthy());
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalledTimes(1));
  expect(transport.startTurn).not.toHaveBeenCalled();
});

it('hydrates a reserved turn that finishes before the admission recheck', async () => {
  const transport = getTransport();
  const initial = conversation('conversation-1');
  transport.activeTurn.mockResolvedValueOnce({
    turn: {
      id: 'recover-turn',
      requestId: 'recover-request',
      conversationId: initial.id,
      branchId: initial.branchId,
      userMessageId: null,
    },
  });
  const completed = {
    ...initial,
    messages: [
      userMessage('admitted-user', 'Admitted question'),
      assistantMessage('recover-turn', 'Already completed answer'),
    ],
  };
  transport.conversation.mockResolvedValue(completed);
  const values = props(initial);
  render(<ChatPanel {...values} />);
  await waitFor(() => expect(screen.getByText('Admitted question')).toBeTruthy());
  expect(screen.getByText('Already completed answer')).toBeTruthy();
  expect(values.onConversation).toHaveBeenCalledWith(completed);
  expect(transport.turnEvents).not.toHaveBeenCalled();
});

it('hydrates a reply completed between the initial history read and active-turn lookup', async () => {
  const transport = getTransport();
  const initial = conversation('conversation-1');
  const completed = {
    ...initial,
    messages: [
      userMessage('completed-user', 'Completed question'),
      assistantMessage('completed-turn', 'Completed answer'),
    ],
  };
  transport.conversation.mockResolvedValue(completed);
  const values = props(initial);
  render(<ChatPanel {...values} />);
  await waitFor(() => expect(screen.getByText('Completed question')).toBeTruthy());
  expect(screen.getByText('Completed answer')).toBeTruthy();
  expect(values.onConversation).toHaveBeenCalledWith(completed);
  expect(transport.turnEvents).not.toHaveBeenCalled();
});

it.each(['active', 'idle'])(
  'ignores stale %s recovery after a local turn starts and finishes',
  async (state) => {
    const transport = getTransport();
    const initial = conversation('conversation-1');
    if (state === 'active')
      transport.activeTurn.mockResolvedValueOnce({
        turn: {
          id: 'old-turn',
          requestId: 'old-request',
          conversationId: initial.id,
          branchId: initial.branchId,
          userMessageId: 'old-user',
        },
      });
    let resolveHistory!: (value: Conversation) => void;
    transport.conversation.mockImplementation(
      () =>
        new Promise<Conversation>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const stream = openTurn('local-turn', { userMessageId: 'local-user' });
    const values = props(initial);
    const view = render(<ChatPanel {...values} />);
    values.onConversation.mockImplementation((next: Conversation) =>
      view.rerender(<ChatPanel {...values} conversation={next} />),
    );
    await waitFor(() => expect(transport.conversation).toHaveBeenCalled());
    setComposerValue(screen.getByLabelText('Message'), 'Local question');
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(1));
    act(() => {
      stream.emit(...replyChunks('local-turn', 'Local answer'));
      stream.done();
    });
    await waitFor(() => expect(screen.getByText('Local answer')).toBeTruthy());
    await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
    await act(async () =>
      resolveHistory({
        ...initial,
        messages: [
          userMessage('old-user', 'Stale question'),
          assistantMessage('old-turn', 'Stale answer'),
        ],
      }),
    );
    expect(screen.getByText('Local question')).toBeTruthy();
    expect(screen.getByText('Local answer')).toBeTruthy();
    expect(screen.queryByText('Stale question')).toBeNull();
    expect(transport.turnEvents.mock.calls.map(([turnId]) => turnId)).toEqual(['local-turn']);
    expect(textOf(values.onConversation.mock.calls.at(-1)?.[0]?.messages.at(-1))).toBe(
      'Local answer',
    );
  },
);
