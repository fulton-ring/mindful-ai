// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Annotation, AnnotationEvent, ChatEvent, Conversation } from '@walden/contracts';
import { expect, it } from 'vitest';
import { ChatPanel } from '../ChatPanel';
import { getTransport, props } from './_ChatPanel.test-helpers';

const transport = getTransport();

it('replaces a streamed multiple-choice reply with the completed learning check', async () => {
  const question = 'Where does the Calvin cycle occur?';
  const rawQuiz = `${question}\nA) Thylakoid\nB) Stroma`;
  transport.streamChat.mockImplementation(async (_input, onEvent: (event: ChatEvent) => void) => {
    onEvent({ type: 'text', text: rawQuiz });
    onEvent({
      type: 'intervention',
      intervention: {
        id: 'check',
        kind: 'learning_check',
        questions: [
          {
            id: 'location',
            header: 'Location',
            format: 'multiple_choice',
            question,
            options: ['Thylakoid', 'Stroma'],
          },
        ],
      },
    });
    onEvent({
      type: 'done',
      annotationsHandled: true,
      message: {
        id: 'answer',
        role: 'assistant',
        content: '',
        createdAt: '',
        learningCheck: {
          id: 'check',
          kind: 'learning_check',
          questions: [
            {
              id: 'location',
              header: 'Location',
              format: 'multiple_choice',
              question,
              options: ['Thylakoid', 'Stroma'],
            },
          ],
        },
      },
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      title: 'Conversation',
      expiresAt: '2026-09-25T00:00:00.000Z',
    });
  });
  const values = props();
  const view = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) => {
    view.rerender(<ChatPanel {...values} conversation={next} />);
  });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Quiz me' } });
  fireEvent.click(screen.getByLabelText('Send message'));

  await waitFor(() =>
    expect(values.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ id: 'answer', content: '' })]),
      }),
    ),
  );
  expect(screen.queryByText(rawQuiz)).toBeNull();
  expect(screen.getByRole('button', { name: 'Capture intervention' })).not.toBeNull();
});

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
