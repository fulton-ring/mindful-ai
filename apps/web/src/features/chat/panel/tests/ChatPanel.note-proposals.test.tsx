// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Conversation, NoteProposalEvent } from '@walden/contracts';
import { expect, it, vi } from 'vitest';
import {
  assistantMessage,
  conversation,
  getTransport,
  hang,
  props,
  reply,
  replyChunks,
  setComposerValue,
} from '../../tests/_ChatPanel.test-helpers';

const { ChatPanel } = await import('../../ChatPanel');

const transport = getTransport();

function configureProposalAbort() {
  let emitProposal: ((event: unknown) => void) | undefined;
  let proposalSignal: AbortSignal | undefined;
  transport.annotationResults.mockResolvedValue([]);
  transport.streamNoteProposal.mockImplementation(
    async (_messageId, _input, onEvent: (event: unknown) => void, signal: AbortSignal) => {
      emitProposal = onEvent;
      proposalSignal = signal;
      return new Promise<void>(() => undefined);
    },
  );
  reply(replyChunks('assistant-proposal', 'Response'));
  return {
    ready: () => emitProposal !== undefined,
    emit: (event: unknown) => emitProposal?.(event),
    signal: () => proposalSignal,
  };
}

it('aborts a streaming note proposal and ignores a late terminal event', async () => {
  const proposal = configureProposalAbort();
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });
  setComposerValue(screen.getByLabelText('Message'), 'Question');
  fireEvent.click(screen.getByLabelText('Send message'));
  // Note suggestions are asked for, never automatic.
  await screen.findByRole('button', { name: 'Add selection to note' });
  fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
  await waitFor(() => expect(proposal.ready()).toBe(true));
  proposal.emit({
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
  const cancel = [...values.onProposalCancelable.mock.calls].reverse().find((call) => call[0])?.[0];

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
  expect(proposal.signal()?.aborted).toBe(true);
  expect(transport.cancelNoteProposal).toHaveBeenCalledWith('assistant-proposal', {
    conversationId: 'conversation-1',
    branchId: 'branch-1',
    attemptId: 'proposal-attempt',
  });
  proposal.emit({
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
    messages: [assistantMessage('reply', 'An answer')],
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
    messages: [assistantMessage('reply', 'An answer')],
  });
  render(<ChatPanel {...values} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
  await screen.findByText('Proposal unavailable');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Add selection to note' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry note proposal' }));

  await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(2));
  expect(transport.streamNoteProposal.mock.calls[1]?.[0]).toBe('reply');
});

it('never proposes a note on its own when a response completes', async () => {
  transport.annotationResults.mockReturnValue(new Promise(() => undefined));
  transport.streamNoteProposal.mockImplementation(
    async (_messageId, _input, onEvent: (event: NoteProposalEvent) => void) => {
      onEvent({ type: 'done', proposal: null });
    },
  );
  reply(replyChunks('assistant-auto-proposal', 'Completed answer'));
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });

  setComposerValue(screen.getByLabelText('Message'), 'Help me think');
  fireEvent.click(screen.getByLabelText('Send message'));

  // Highlights still run on their own; note suggestions are only ever asked
  // for, so a completed answer with nothing worth keeping hands the reader
  // nothing to accept or reject.
  await waitFor(() => expect(transport.streamMessageAnnotations).toHaveBeenCalledTimes(1));
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();
});

it('keeps a visible note suggestion alive while the next message starts', async () => {
  let proposalSignal: AbortSignal | undefined;
  reply(replyChunks('assistant-first-note', 'First answer'), 'turn-first');
  hang('turn-second');
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
  setComposerValue(screen.getByLabelText('Message'), 'First');
  fireEvent.click(screen.getByLabelText('Send message'));
  await screen.findByRole('button', { name: 'Add selection to note' });
  fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
  await waitFor(() => expect(proposalSignal).toBeDefined());
  setComposerValue(screen.getByLabelText('Message'), 'Second');
  fireEvent.click(screen.getByLabelText('Send message'));
  expect(proposalSignal?.aborted).toBe(false);
});

it('offers a selection capture on any completed response while keeping other response actions', async () => {
  transport.annotationResults.mockResolvedValue([]);
  transport.streamNoteProposal.mockReturnValue(new Promise(() => undefined));
  const history = {
    ...conversation('conversation-1'),
    messages: [
      assistantMessage('assistant-old', 'Old response'),
      assistantMessage('assistant-latest', '**Latest response**'),
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
    messages: [assistantMessage('assistant-stranded', 'Selected exact text')],
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
    messages: [assistantMessage('assistant-empty', 'Selected exact text')],
  });
  render(<ChatPanel {...values} />);

  fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));

  await waitFor(() => expect(values.onGhost).toHaveBeenCalledWith(null, false, expect.any(String)));
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
    messages: [assistantMessage('assistant-declined', 'Selected exact text')],
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
    messages: [assistantMessage('assistant-1', 'Selected exact text')],
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
  // The selected text fixes placement while the proposed wording streams.
  expect(values.onProposalStart).toHaveBeenCalledWith(expect.any(String), 'Selected exact text');
  expect(values.onOpenNote).toHaveBeenCalledOnce();
});

it('offers a manual note proposal for a completed reply', async () => {
  transport.streamNoteProposal.mockResolvedValue(undefined);
  const history = {
    ...conversation('conversation-1'),
    messages: [assistantMessage('assistant-1', 'Change the term in the note.')],
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
    messages: [assistantMessage('assistant-batch-source', 'A C')],
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
    messages: [assistantMessage('assistant-capture-retry', 'Selected exact text')],
  });
  render(<ChatPanel {...values} />);

  fireEvent.click(screen.getByRole('button', { name: 'Add selection to note' }));
  await screen.findByText('Proposal unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry note proposal' }));

  await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(2));
  expect(transport.streamNoteProposal.mock.calls[1]?.[1]).toEqual(
    expect.objectContaining({ action: 'capture', captureText: 'Selected exact text' }),
  );
  expect(values.onProposalStart).toHaveBeenLastCalledWith(
    expect.any(String),
    'Selected exact text',
  );
});

it('routes intervention capture through the same streamed proposal pipeline', async () => {
  // The turn is still running: the card captures into the latest finished reply.
  hang().emit(
    { type: 'start', messageId: 'turn-1', messageMetadata: { createdAt: '' } },
    {
      type: 'data-intervention',
      id: 'intervention-1',
      data: {
        id: 'intervention-1',
        kind: 'ask',
        question: 'Keep this?',
        options: ['Intervention exact text'],
      },
    },
  );
  transport.streamNoteProposal.mockResolvedValue(undefined);
  const history = {
    ...conversation('conversation-1'),
    messages: [assistantMessage('assistant-source', 'Earlier completed response')],
  };
  const values = props(history);
  render(<ChatPanel {...values} />);
  setComposerValue(screen.getByLabelText('Message'), 'Continue');
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
  expect(values.onProposalStart).toHaveBeenCalledWith(
    expect.any(String),
    'Intervention exact text',
  );
});

it('proposes a recorded note once the reply that recorded it finishes', async () => {
  transport.annotationResults.mockResolvedValue([]);
  transport.streamNoteProposal.mockResolvedValue(undefined);
  reply(
    replyChunks('assistant-record', 'Worth keeping.', {
      body: [
        {
          type: 'data-intervention',
          id: 'record-1',
          data: { id: 'record-1', kind: 'record', text: 'Keep this line.', reason: 'Useful' },
        },
      ],
    }),
  );
  const values = props();
  const rendered = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    rendered.rerender(<ChatPanel {...values} conversation={next} />);
  });
  setComposerValue(screen.getByLabelText('Message'), 'Remember this');
  fireEvent.click(screen.getByLabelText('Send message'));

  await waitFor(() => expect(transport.streamNoteProposal).toHaveBeenCalledTimes(1));
  expect(transport.streamNoteProposal).toHaveBeenCalledWith(
    'assistant-record',
    expect.objectContaining({
      action: 'capture',
      captureText: 'Keep this line.',
      noteRevision: null,
    }),
    expect.any(Function),
    expect.any(AbortSignal),
  );
  // Automatic highlights run for the finished reply too.
  expect(transport.annotationResults.mock.calls[0]?.[0]).toBe('assistant-record');
});
