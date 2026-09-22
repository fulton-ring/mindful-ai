// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '@walden/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMessageActions } from '../hooks/actions/use-message-actions';

const message: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'Copied text',
  createdAt: '2026-09-21T00:00:00.000Z',
};

function Harness({ onFailure }: { onFailure: (value: string) => void }) {
  const { copyMessage } = useMessageActions(onFailure);
  return (
    <button type="button" onClick={() => void copyMessage(message)}>
      Copy
    </button>
  );
}

describe('useMessageActions', () => {
  afterEach(cleanup);
  it('reports clipboard failures to the panel', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const onFailure = vi.fn();
    render(<Harness onFailure={onFailure} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() =>
      expect(onFailure).toHaveBeenCalledWith('The response could not be copied.'),
    );
  });

  it('clears the copied-message timer on unmount', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    const view = render(<Harness onFailure={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    view.unmount();
    expect(clearTimeout).toHaveBeenCalled();
    clearTimeout.mockRestore();
  });
});
