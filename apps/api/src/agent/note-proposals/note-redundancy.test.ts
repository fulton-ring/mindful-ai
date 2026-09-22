import type { Note } from '@walden/contracts';
import { isRedundantAddition } from '@walden/domain';
import { describe, expect, it } from 'vitest';
import { noteProposalFromCandidate } from '../index';

const note = (markdown: string): Note => ({
  id: 'note',
  title: 'Note',
  markdown,
  revision: 1,
  provenance: [],
  createdAt: 'now',
  updatedAt: 'now',
});

const addition = (text: string) => ({
  shouldPropose: true as const,
  captureBasis: 'user_decision' as const,
  mode: 'add' as const,
  oldText: '',
  newText: text,
  reason: 'Captures the decision.',
});

describe('isRedundantAddition', () => {
  it('treats a restatement of the same fact as redundant', () => {
    expect(
      isRedundantAddition(
        'Team will ship the beta on March 14 and cap the pilot at 50 users.',
        'Beta ships March 14, pilot capped at 50 users.',
      ),
    ).toBe(true);
  });

  it('keeps a correction that changes a load-bearing number', () => {
    expect(
      isRedundantAddition(
        'Team will ship the beta on March 14 and cap the pilot at 50 users.',
        'Beta ships March 21, pilot capped at 50 users.',
      ),
    ).toBe(false);
  });

  it('keeps an addition that introduces a new name', () => {
    expect(
      isRedundantAddition(
        'Team will ship the beta on March 14 and cap the pilot at 50 users.',
        'Priya is running the pilot.',
      ),
    ).toBe(false);
  });

  it('ignores one-word fragments rather than guessing', () => {
    expect(isRedundantAddition('Beta ships March 14.', 'Beta.')).toBe(false);
  });
});

describe('noteProposalFromCandidate redundancy guard', () => {
  const existing = 'Team will ship the beta on March 14 and cap the pilot at 50 users.';

  it('declines an addition the note already states', () => {
    expect(
      noteProposalFromCandidate(
        note(existing),
        'turn',
        addition('Beta ships March 14, pilot capped at 50 users.'),
        true,
      ),
    ).toBeNull();
  });

  it('still allows a correction with a different date', () => {
    expect(
      noteProposalFromCandidate(
        note(existing),
        'turn',
        addition('Beta ships March 21, pilot capped at 50 users.'),
        true,
      ),
    ).not.toBeNull();
  });

  it('keeps the new part of an addition whose other part duplicates a note block', () => {
    // One block is a verbatim echo of an existing line; the other is new. The
    // echo must not discard the new fact alongside it.
    const proposal = noteProposalFromCandidate(
      note('Keep cash.\n\nPlan.'),
      'turn',
      addition('Keep cash.\n\nPriya runs the pilot.'),
      true,
    );
    expect(proposal).not.toBeNull();
    expect(proposal?.newText).toContain('Priya runs the pilot.');
  });

  it('declines a standalone one-word addition', () => {
    expect(
      noteProposalFromCandidate(note(existing), 'turn', addition('efficient'), true),
    ).toBeNull();
  });

  it('still allows a short but substantive addition', () => {
    expect(
      noteProposalFromCandidate(note(existing), 'turn', addition('Ship Friday.'), true),
    ).not.toBeNull();
  });

  it('declines a replacement that reintroduces an existing block elsewhere', () => {
    expect(
      noteProposalFromCandidate(
        note(`${existing}\n\nOpen question: staffing.`),
        'turn',
        {
          shouldPropose: true,
          captureBasis: 'user_decision',
          mode: 'replace',
          oldText: 'Open question: staffing.',
          newText: 'Beta ships March 14, pilot capped at 50 users.',
          reason: 'Restates the decision.',
        },
        true,
      ),
    ).toBeNull();
  });
});
