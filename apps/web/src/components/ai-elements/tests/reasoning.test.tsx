// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '../reasoning';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('opens while reasoning streams, closes afterward, and allows reopening', () => {
  vi.useFakeTimers();
  const content = (streaming: boolean) => (
    <Reasoning isStreaming={streaming}>
      <ReasoningTrigger />
      <ReasoningContent>Provider reasoning</ReasoningContent>
    </Reasoning>
  );
  const view = render(content(true));
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  view.rerender(content(false));
  act(() => vi.advanceTimersByTime(1100));
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(view.getByRole('button'));
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  expect(view.getByText('Provider reasoning')).toBeTruthy();
});

it('starts collapsed for saved reasoning', () => {
  const view = render(
    <Reasoning>
      <ReasoningTrigger />
      <ReasoningContent>Saved reasoning</ReasoningContent>
    </Reasoning>,
  );
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
});
