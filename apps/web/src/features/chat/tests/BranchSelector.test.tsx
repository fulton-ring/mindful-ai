// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BranchSelector } from '../BranchSelector';

it('renders the selected sibling as a compact custom control', () => {
  const onSelect = vi.fn();
  render(
    <BranchSelector
      selectedId="branch-1"
      branches={[
        {
          id: 'branch-1',
          forkedFromMessageId: null,
          headMessageId: 'answer-1',
          expiresAt: '2026-09-25T00:00:00.000Z',
        },
        {
          id: 'branch-2',
          forkedFromMessageId: 'answer-1',
          headMessageId: 'answer-2',
          expiresAt: '2026-09-25T00:00:00.000Z',
        },
      ]}
      onSelect={onSelect}
    />,
  );

  expect(screen.getByLabelText('Response path 1 of 2').textContent).toBe('1 / 2');
  expect(
    screen.getByRole('button', { name: 'Previous response path' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Next response path' }));
  expect(onSelect).toHaveBeenCalledWith('branch-2');
});
