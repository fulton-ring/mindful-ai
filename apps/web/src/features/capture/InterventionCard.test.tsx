// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InterventionCard } from './InterventionCard';

afterEach(cleanup);

it('accepts a typed answer for a learning check without choices', () => {
  const onResolve = vi.fn();
  render(
    <InterventionCard
      intervention={{
        id: 'check',
        kind: 'learning_check',
        questions: [
          {
            id: 'location',
            header: 'Location',
            format: 'short_answer',
            question: 'Where is the stroma?',
          },
        ],
      }}
      onResolve={onResolve}
      onCapture={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  const next = screen.getByRole('button', { name: 'Next' });
  expect(next.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Your answer: Location' }), {
    target: { value: 'Inside the chloroplast, outside the thylakoids' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

  expect(onResolve).toHaveBeenCalledWith({
    checkId: 'check',
    answers: { location: { answers: ['Inside the chloroplast, outside the thylakoids'] } },
  });
});

it('keeps a multiple-choice answer editable until the check is submitted', () => {
  const onResolve = vi.fn();
  render(
    <InterventionCard
      intervention={{
        id: 'check',
        kind: 'learning_check',
        questions: [
          {
            id: 'stage',
            header: 'Stage',
            format: 'multiple_choice',
            question: 'Which stage uses ATP?',
            options: ['Fixation', 'Reduction'],
          },
        ],
      }}
      onResolve={onResolve}
      onCapture={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Other' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Your answer' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Reduction' }));
  expect(onResolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
  expect(onResolve).toHaveBeenCalledWith({
    checkId: 'check',
    answers: { stage: { answers: ['Reduction'] } },
  });
});

it('collects several visible questions before submitting one structured response', () => {
  const onResolve = vi.fn();
  render(
    <InterventionCard
      intervention={{
        id: 'check-3',
        kind: 'learning_check',
        questions: [
          {
            id: 'location',
            header: 'Location',
            format: 'multiple_choice',
            question: 'Where does the Calvin cycle happen?',
            options: ['Stroma', 'Thylakoid'],
          },
          {
            id: 'purpose',
            header: 'Purpose',
            format: 'short_answer',
            question: 'What does the cycle produce?',
          },
        ],
      }}
      onResolve={onResolve}
      onCapture={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole('radio', { name: 'Stroma' }));
  expect(screen.getByText(/What does the cycle produce/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Your answer: Purpose'), { target: { value: 'G3P' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

  expect(onResolve).toHaveBeenCalledWith({
    checkId: 'check-3',
    answers: {
      location: { answers: ['Stroma'] },
      purpose: { answers: ['G3P'] },
    },
  });
});
