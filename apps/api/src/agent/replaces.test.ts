import { describe, expect, it } from 'vitest';
import { noteProposalFromCandidate } from './index';

const note = {
  id: 'note',
  title: 'Plan',
  markdown: 'Beta ships March 14.',
  revision: 2,
  provenance: [],
  createdAt: 'now',
  updatedAt: 'now',
};
const candidate = (replaces: string | null) => ({
  shouldPropose: true as const,
  captureBasis: 'user_decision' as const,
  mode: 'add' as const,
  replaces,
  oldText: '',
  newText: 'Pilot is capped at 50 users.',
  reason: 'Captures the decision.',
});

describe('superseding a pending proposal', () => {
  it('carries a supersede that names a pending proposal', () => {
    const proposal = noteProposalFromCandidate(note, 'turn', candidate('pending-1'), true, {
      pendingProposalIds: ['pending-1', 'pending-2'],
    });

    expect(proposal?.replaces).toBe('pending-1');
  });

  it('drops an id the model invented', () => {
    // A supersede invalidates a stored row, so an unchecked id would let model
    // output discard suggestions the reader never saw this proposal replace.
    const proposal = noteProposalFromCandidate(note, 'turn', candidate('not-a-real-id'), true, {
      pendingProposalIds: ['pending-1'],
    });

    expect(proposal).not.toBeNull();
    expect(proposal?.replaces).toBeUndefined();
  });

  it('drops a supersede when nothing is pending', () => {
    expect(
      noteProposalFromCandidate(note, 'turn', candidate('pending-1'), true)?.replaces,
    ).toBeUndefined();
  });

  it('leaves an ordinary proposal without the field', () => {
    const proposal = noteProposalFromCandidate(note, 'turn', candidate(null), true, {
      pendingProposalIds: ['pending-1'],
    });

    expect(proposal).not.toBeNull();
    expect('replaces' in (proposal ?? {})).toBe(false);
  });
});
