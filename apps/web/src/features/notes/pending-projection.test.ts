import { ChangeSet, EditorState } from '@codemirror/state';
import type { EditProposal } from '@walden/contracts';
import { acceptQueueEdit } from '@walden/domain';
import { describe, expect, it } from 'vitest';
import {
  acceptedProposalMarkdown,
  additionQueue,
  candidateOnLine,
  projectPendingEdits,
} from './pending-projection';

function proposal(id: string, oldText: string, newText: string): EditProposal {
  return {
    id,
    noteId: 'note-1',
    baseRevision: 4,
    oldText,
    newText,
    reason: 'test',
    status: 'pending',
  };
}

function describeReplacementProjection(): void {
  it('submits the exact reviewed replacement, including untouched text', () => {
    const replacement = proposal('edit', 'old', 'new');
    expect(acceptedProposalMarkdown('Start old end', replacement, [replacement])).toBe(
      'Start new end',
    );
    expect(acceptedProposalMarkdown('Start changed end', replacement, [replacement])).toBeNull();
  });
  it('places an addition after the note, whatever the note has become', () => {
    const pending = proposal('second', '', 'Second');
    const result = projectPendingEdits('First', [pending]);
    expect(result.issues).toEqual([]);
    // After the note, not before it: a pending suggestion must never push
    // already-accepted text down the page.
    expect(result.text).toBe('First\n\nSecond');
    expect(result.ranges.map((range) => range.proposalId)).toEqual(['second']);
  });

  it('projects independent exact edits and maps their display and source ranges', () => {
    const markdown = 'Monday plan\nSave four months\nDone';
    const result = projectPendingEdits(markdown, [
      proposal('day', 'Monday', 'Tuesday'),
      proposal('months', 'four', 'fourteen'),
    ]);

    expect(markdown).toBe('Monday plan\nSave four months\nDone');
    expect(result.text).toBe('Tuesday plan\nSave fourteen months\nDone');
    expect(result.ranges).toEqual([
      { proposalId: 'day', from: 0, to: 4, sourceFrom: 0, sourceTo: 3, insert: 'Tues' },
      { proposalId: 'months', from: 22, to: 26, sourceFrom: 21, sourceTo: 21, insert: 'teen' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('surfaces every overlapping proposal and projects only independent candidates', () => {
    const result = projectPendingEdits('alpha beta gamma', [
      proposal('whole', 'alpha beta', 'first second'),
      proposal('beta', 'beta', 'BETA'),
      proposal('gamma', 'gamma', 'GAMMA'),
    ]);

    expect(result.text).toBe('alpha beta GAMMA');
    expect(result.ranges.map((range) => range.proposalId)).toEqual(['gamma']);
    expect(result.issues).toEqual([
      { kind: 'overlap', proposalId: 'whole', withProposalIds: ['beta'] },
      { kind: 'overlap', proposalId: 'beta', withProposalIds: ['whole'] },
    ]);
  });

  it('reports invalid patches instead of silently omitting them', () => {
    const result = projectPendingEdits('one', [proposal('missing', 'two', 'three')]);

    expect(result.text).toBe('one');
    expect(result.ranges).toEqual([]);
    expect(result.issues).toEqual([
      { kind: 'invalid', proposalId: 'missing', message: 'The proposed oldText was not found' },
    ]);
  });
}

function describeCandidateProjection(): void {
  it('returns a unique candidate only when one pending range touches the cursor line', () => {
    const projection = projectPendingEdits('one two\nthree\nfour', [
      proposal('one', 'one', 'ONE'),
      proposal('two', 'two', 'TWO'),
      proposal('three', 'three', 'THREE'),
    ]);

    expect(candidateOnLine(projection, projection.text.indexOf(' '))).toEqual({
      kind: 'ambiguous',
      proposalIds: ['one', 'two'],
    });
    expect(candidateOnLine(projection, 1)).toEqual({ kind: 'unique', proposalId: 'one' });
    expect(candidateOnLine(projection, projection.text.indexOf('THREE') + 2)).toEqual({
      kind: 'unique',
      proposalId: 'three',
    });
    expect(candidateOnLine(projection, projection.text.indexOf('four'))).toEqual({
      kind: 'none',
    });
  });

  it('does not assign leading separator lines to an appended candidate', () => {
    const projection = projectPendingEdits('Existing', [
      proposal('append', 'Existing', 'Existing\n\nNew paragraph'),
    ]);

    expect(candidateOnLine(projection, 'Existing'.length)).toEqual({ kind: 'none' });
    expect(candidateOnLine(projection, projection.text.indexOf('New'))).toEqual({
      kind: 'unique',
      proposalId: 'append',
    });
  });

  it('projects same-anchor insertions in arrival order as independent candidates', () => {
    // Every candidate for an empty note shares an anchor, so the tiebreak is
    // what the reader actually sees. Ordering by id put a capture above
    // suggestions made before it, and moved things when the set changed.
    const result = projectPendingEdits('', [
      proposal('b', '', 'Second'),
      proposal('a', '', 'First'),
    ]);

    expect(result.text).toBe('Second\n\nFirst');
    expect(result.issues).toEqual([]);
    expect(result.ranges).toEqual([
      // `insert` carries the separator the addition brings with it; `from`..`to`
      // bound only its own text.
      { proposalId: 'b', from: 0, to: 6, sourceFrom: 0, sourceTo: 0, insert: 'Second' },
      { proposalId: 'a', from: 8, to: 13, sourceFrom: 0, sourceTo: 0, insert: '\n\nFirst' },
    ]);
    expect(candidateOnLine(result, 2)).toEqual({ kind: 'unique', proposalId: 'b' });
    expect(candidateOnLine(result, 9)).toEqual({ kind: 'unique', proposalId: 'a' });
  });

  it('keeps separator blank lines outside a candidate range', () => {
    // Deleting the paragraph above a suggestion — trailing newline included,
    // which is what a line selection gives you — used to count as touching the
    // suggestion, and the editor dismissed it.
    const note = 'Accepted paragraph.';
    const result = projectPendingEdits(note, [
      proposal('a', '', '- First'),
      proposal('b', '', '- Second'),
    ]);

    expect(result.text).toBe('Accepted paragraph.\n\n- First\n\n- Second');
    // Each range starts after its blank lines, not on them.
    for (const range of result.ranges) {
      expect(result.text.slice(range.from, range.to).startsWith('\n')).toBe(false);
      expect(result.text[range.from - 1]).toBe('\n');
    }
    // A deletion covering the paragraph and its newline stops short of the first.
    expect(result.ranges[0]!.from).toBeGreaterThan(note.length + 1);
  });
}

describe('pending note projection', () => {
  describe('replacements', describeReplacementProjection);
  describe('candidate ranges', describeCandidateProjection);
});

/** The note as it reads once `id` is kept and the other ghosts are taken out. */
const accepted = (
  markdown: string,
  proposals: EditProposal[],
  order: { id: string; text: string; accepted: boolean }[],
  id: string,
) => {
  const edit = acceptQueueEdit(markdown, additionQueue(proposals, order), id);
  if (!edit) throw new Error(`no edit for ${id}`);
  return markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to);
};

function describeHiddenAdditionAcceptance(): void {
  it('keeps an addition where the preview drew it when a pending sibling is hidden', () => {
    // 'hidden' is pending on the server but not on screen — dismissed here, or
    // on another branch. Laying it out anyway put a chunk above the accepted
    // text that the reader could not see, which clamped the placement and sent
    // the addition to the end of the note instead of the middle, where it was
    // drawn.
    const markdown = 'Budget is fixed at 40k.\n\nHiring pauses until June.';
    const visible = [proposal('shown', '', 'Budget review happens monthly.')];
    const order = [
      { id: 'hidden', text: 'Office moves in August.', accepted: false },
      { id: 'shown', text: 'Budget review happens monthly.', accepted: false },
    ];

    const preview = projectPendingEdits(markdown, visible, new Map(), order);

    expect(preview.text).toBe(
      'Budget is fixed at 40k.\n\nBudget review happens monthly.\n\nHiring pauses until June.',
    );
    expect(accepted(markdown, visible, order, 'shown')).toBe(preview.text);
  });
}

function assertQueueAgreement(markdown: string, first: string, second: string): void {
  if (first === second) return;
  const proposals = [proposal('a', '', first), proposal('b', '', second)];
  const order = [
    { id: 'hidden', text: 'Office moves in August.', accepted: false },
    ...proposals.map((item) => ({ id: item.id, text: item.newText, accepted: false })),
  ];
  const preview = projectPendingEdits(markdown, proposals, new Map(), order);
  for (const id of ['a', 'b']) {
    const other = id === 'a' ? second : first;
    const expected = preview.text
      .replace(other, '')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
    expect(accepted(markdown, proposals, order, id).trim()).toBe(expected);
  }
}

function describeQueueAgreement(): void {
  it('agrees with the preview for every shape of queue', () => {
    const notes = [
      '',
      'Budget is fixed at 40k.',
      '# Risks\n\nVendor lock-in.',
      'Budget is fixed at 40k.\n\nHiring pauses until June.',
      '# Plan\n\nShip in March.\n\n# Risks\n\nVendor lock-in.',
    ];
    const texts = [
      'Budget review happens monthly.',
      'Priya runs the pilot.',
      'Vendor contract ends in May.',
      'Ship date slips to April.',
    ];
    for (const markdown of notes)
      for (const first of texts)
        for (const second of texts) assertQueueAgreement(markdown, first, second);
  });
}

function describeOutOfOrderAcceptance(): void {
  it('accepting out of order leaves the note reading as it was previewed', () => {
    const markdown = 'Budget is fixed at 40k.';
    const proposals = [
      proposal('first', '', 'Hiring pauses until June.'),
      proposal('second', '', 'Office moves in August.'),
    ];
    const order = proposals.map((item) => ({
      id: item.id,
      text: item.newText,
      accepted: false,
    }));
    const preview = projectPendingEdits(markdown, proposals, new Map(), order);

    // Take the second one first. It stays where it was drawn — after the first —
    // rather than jumping above it.
    const after = accepted(markdown, proposals, order, 'second');
    expect(after).toBe('Budget is fixed at 40k.\n\nOffice moves in August.');
    expect(preview.text.indexOf('Office moves')).toBeGreaterThan(
      preview.text.indexOf('Hiring pauses'),
    );

    // The first one now renders against the note that acceptance left behind,
    // still above its accepted sibling.
    const remaining = [proposals[0]!];
    const settled = [
      { id: 'first', text: 'Hiring pauses until June.', accepted: false },
      { id: 'second', text: 'Office moves in August.', accepted: true },
    ];
    expect(accepted(after, remaining, settled, 'first')).toBe(
      'Budget is fixed at 40k.\n\nHiring pauses until June.\n\nOffice moves in August.',
    );
  });
}

describe('accepting what was previewed', () => {
  describe('hidden additions', describeHiddenAdditionAcceptance);
  describe('queue agreement', describeQueueAgreement);
  describe('out of order', describeOutOfOrderAcceptance);
});

describe('mapping between the note and what is rendered', () => {
  /** The editor's own map: the saved note, plus every projected change. */
  const rebuild = (markdown: string, projection: ReturnType<typeof projectPendingEdits>) =>
    ChangeSet.of(
      projection.ranges.map((range) => ({
        from: range.sourceFrom,
        to: range.sourceTo,
        insert: range.insert,
      })),
      markdown.length,
    )
      .apply(EditorState.create({ doc: markdown }).doc)
      .toString();

  it('rebuilds the rendered document exactly, separators included', () => {
    // The map used to insert only each addition's text. An addition's blank
    // lines are outside its decorated bounds, so every position below one was
    // two characters short per suggestion — and an edit there was applied to
    // the wrong span of the saved note, which read as the cursor jumping and
    // deleting something else.
    const cases: [string, EditProposal[]][] = [
      [
        'Budget is fixed at 40k.\n\nHiring pauses until June.',
        [proposal('a', '', 'Review monthly.')],
      ],
      ['', [proposal('a', '', 'First.')]],
      [
        'Budget is fixed at 40k.\n\nHiring pauses until June.',
        [proposal('a', '', 'Review monthly.'), proposal('b', '', 'Priya runs the pilot.')],
      ],
      [
        'Budget is fixed at 40k.\n\nHiring pauses until June.',
        [proposal('a', '', 'Review monthly.'), proposal('b', 'Hiring', 'Recruiting')],
      ],
    ];

    for (const [markdown, proposals] of cases) {
      const order = proposals
        .filter((item) => item.oldText === '')
        .map((item) => ({ id: item.id, text: item.newText, accepted: false }));
      const projection = projectPendingEdits(markdown, proposals, new Map(), order);
      expect(rebuild(markdown, projection)).toBe(projection.text);
    }
  });
});
