// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Annotation, AnnotationEvent, Conversation, LearningCheck } from '@walden/contracts';
import { expect, it } from 'vitest';
import {
  getTransport,
  hang,
  props,
  reply,
  replyChunks,
  setComposerValue,
  textChunks,
} from '../../tests/_ChatPanel.test-helpers';

const { ChatPanel } = await import('../../ChatPanel');

const transport = getTransport();
const question = 'Where does the Calvin cycle occur?';
const check: LearningCheck = {
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
};

function renderSaving() {
  const values = props();
  const view = render(<ChatPanel {...values} />);
  values.onConversation.mockImplementation((next: Conversation) =>
    view.rerender(<ChatPanel {...values} conversation={next} />),
  );
  return values;
}

function send(text: string) {
  setComposerValue(screen.getByLabelText('Message'), text);
  fireEvent.click(screen.getByLabelText('Send message'));
}

it('shows a learning check instead of the streamed multiple-choice text', async () => {
  const rawQuiz = `${question}\nA) Thylakoid\nB) Stroma`;
  reply(
    replyChunks('answer', rawQuiz, {
      body: [
        { type: 'data-intervention', id: 'check', data: check },
        // The server marks a reply whose text was only the quiz.
        { type: 'message-metadata', messageMetadata: { quizOnly: true } },
      ],
    }),
  );
  const values = renderSaving();
  send('Quiz me');

  await waitFor(() =>
    expect(values.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: 'answer',
            parts: expect.arrayContaining([
              { type: 'data-intervention', id: 'check', data: check },
            ]),
          }),
        ]),
      }),
    ),
  );
  expect(screen.queryByText(/A\) Thylakoid/)).toBeNull();
  expect(screen.getByText('Learning check card')).toBeTruthy();
  // A learning check has no response toolbar of its own.
  expect(screen.queryByRole('button', { name: 'Regenerate response' })).toBeNull();
});

it('keeps an answer on screen when the reply goes on to quiz about it', async () => {
  const answer = 'The Calvin cycle builds sugar from carbon dioxide inside the chloroplast.';
  reply(
    replyChunks('answer', answer, {
      body: [{ type: 'data-intervention', id: 'check', data: check }],
    }),
  );
  const values = renderSaving();
  send('Explain the Calvin cycle, then quiz me');

  await waitFor(() => expect(values.onConversation).toHaveBeenCalled());
  expect(await screen.findByText(answer)).toBeTruthy();
  expect(screen.getByText('Learning check card')).toBeTruthy();
});

it('submits answers as a structured response and shows them as the reader’s answers', async () => {
  reply(
    replyChunks('answer', '', { body: [{ type: 'data-intervention', id: 'check', data: check }] }),
  );
  renderSaving();
  send('Quiz me');
  const submit = await screen.findByRole('button', { name: 'Submit answers' });
  await waitFor(() => expect(screen.getByLabelText('Send message')).toBeTruthy());
  hang('turn-2');
  fireEvent.click(submit);
  await waitFor(() => expect(transport.startTurn).toHaveBeenCalledTimes(2));
  expect(transport.startTurn.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({
      action: 'feedback',
      message: 'Stroma',
      learningCheckResponse: { checkId: 'check', answers: { location: { answers: ['Stroma'] } } },
    }),
  );
  expect(await screen.findByText('My answers')).toBeTruthy();
  expect(screen.getByText('Location')).toBeTruthy();
});

it('shows primary-stream highlights before completion without classifying twice', async () => {
  const stream = hang();
  transport.streamNoteProposal.mockResolvedValue(undefined);
  renderSaving();
  send('Question');
  await waitFor(() => expect(transport.turnEvents).toHaveBeenCalled());
  const annotation: Annotation = {
    id: 'early',
    quote: 'Ice floats.',
    kind: 'fact',
    whose: 'assistant',
  };
  act(() =>
    stream.emit(
      { type: 'start', messageId: 'early-answer', messageMetadata: { createdAt: '' } },
      ...textChunks('Ice floats.'),
      { type: 'message-metadata', messageMetadata: { annotations: [annotation] } },
    ),
  );
  await waitFor(() =>
    expect(screen.getByText('Ice floats.').getAttribute('data-annotation-count')).toBe('1'),
  );
  await act(async () => {
    stream.emit({ type: 'finish' });
    stream.done();
  });
  await waitFor(() => expect(screen.getByLabelText('Send message')).toBeTruthy());
  expect(screen.getByText('Ice floats.').getAttribute('data-annotation-count')).toBe('1');
  expect(transport.streamMessageAnnotations).not.toHaveBeenCalled();
  // Nothing asks for a note here, so none is proposed.
  expect(transport.streamNoteProposal).not.toHaveBeenCalled();
});

it('keeps streamed highlights when the terminal classifier result is incomplete', async () => {
  reply(replyChunks('assistant-highlights', 'Ice floats. Water freezes.'));
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
  renderSaving();
  send('Question');
  await waitFor(() =>
    expect(
      screen.getByText('Ice floats. Water freezes.').getAttribute('data-annotation-count'),
    ).toBe('2'),
  );
});
