// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MessageResponse } from '../message';

it('renders single-dollar chemistry formulas in chat responses', () => {
  const { container } = render(
    <MessageResponse>Water is $H_2O$; electrons are $e^-$; protons are $H^+$.</MessageResponse>,
  );
  expect(container.querySelectorAll('.katex')).toHaveLength(3);
  expect(container.textContent).not.toContain('$H_2O$');
});

it('keeps ordinary dollar amounts as text', () => {
  const { container } = render(<MessageResponse>Costs $5 and $10.</MessageResponse>);
  expect(container.querySelector('.katex')).toBeNull();
  expect(container.textContent).toContain('$5 and $10');
});

it('still renders equations that begin with a number', () => {
  const { container } = render(<MessageResponse>Compute $5 + 10$.</MessageResponse>);
  expect(container.querySelector('.katex')).not.toBeNull();
});
