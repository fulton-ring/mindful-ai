// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteThreadDialog } from './DeleteThreadDialog';

afterEach(cleanup);

describe('DeleteThreadDialog', () => {
  it('cancels without deleting', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <DeleteThreadDialog
        title="Planning"
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/its messages, and its note will be permanently deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms once and keeps a failed deletion reviewable', () => {
    const onConfirm = vi.fn();
    const view = render(
      <DeleteThreadDialog
        title="Planning"
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
        pending={false}
        error="The thread could not be deleted."
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('could not be deleted');
  });
});
