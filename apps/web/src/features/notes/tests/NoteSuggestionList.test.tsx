// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import type { EditProposal } from '@walden/contracts';
import { describe, expect, it, vi } from 'vitest';
import { NoteSuggestionList } from '../proposals/NoteSuggestionList';

const proposal: EditProposal = {
  id: 'proposal-1',
  noteId: 'note-1',
  baseRevision: 0,
  oldText: 'old text',
  newText: 'new text',
  reason: 'capture',
  status: 'pending',
};

describe('NoteSuggestionList', () => {
  it('renders a conflict status and routes its reject action to the proposal', () => {
    const onDismiss = vi.fn();
    render(
      <NoteSuggestionList
        issues={[{ kind: 'overlap', proposalId: proposal.id, withProposalIds: [] }]}
        proposals={[proposal]}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain('conflicts with another pending edit');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDismiss).toHaveBeenCalledWith('reject', proposal);
  });
});
