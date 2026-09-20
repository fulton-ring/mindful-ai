import { describe, expect, it } from 'vitest';
import { proposalStillApplies } from './proposal-scope';

describe('proposalStillApplies', () => {
  it('keeps a proposal asked for before the note existed', () => {
    // The very first suggestion in a conversation: there was no note to
    // snapshot, and the proposal itself creates one. Treating the new id as a
    // different note discarded the suggestion and, on the batch path, left the
    // editor waiting on a stream that had already finished — accepting stayed
    // disabled until a reload.
    expect(proposalStillApplies({ noteId: 'unsaved-note' }, { id: 'note-created' })).toBe(true);
  });

  it('keeps a proposal for the note it was made against', () => {
    expect(proposalStillApplies({ noteId: 'note-1' }, { id: 'note-1' })).toBe(true);
  });

  it('drops a proposal once the reader has moved to another note', () => {
    expect(proposalStillApplies({ noteId: 'note-1' }, { id: 'note-2' })).toBe(false);
  });

  it('keeps a proposal while no note is loaded, and drops one with no snapshot', () => {
    expect(proposalStillApplies({ noteId: 'note-1' }, null)).toBe(true);
    expect(proposalStillApplies(null, { id: 'note-1' })).toBe(false);
  });
});
