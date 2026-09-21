// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeleteThreadDialog } from './DeleteThreadDialog';

afterEach(cleanup);

it('warns before archiving and preserves the note', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <DeleteThreadDialog
      title="Planning"
      mode="archive"
      pending={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );

  expect(
    screen.getByText(/messages will be permanently deleted. The note will remain/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});

it('confirms once and keeps a failed deletion reviewable', () => {
  const onConfirm = vi.fn();
  const view = render(
    <DeleteThreadDialog
      title="Planning"
      mode="delete"
      pending={false}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete thread' }));
  expect(onConfirm).toHaveBeenCalledOnce();

  view.rerender(
    <DeleteThreadDialog
      title="Planning"
      mode="delete"
      pending={false}
      error="The thread could not be deleted."
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('could not be deleted');
});

it('warns before deleting a standalone note', () => {
  render(
    <DeleteThreadDialog
      title="Learning journal"
      mode="delete"
      target="note"
      pending={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );

  expect(screen.getByRole('heading', { name: 'Delete note?' })).toBeTruthy();
  expect(screen.getByText(/will be permanently deleted/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete everything' })).toBeTruthy();
});
