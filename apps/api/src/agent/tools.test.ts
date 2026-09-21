import { describe, expect, it } from 'vitest';
import { annotationKindSchema, noteProposalFromCandidate, semanticAnnotations } from './index';

const note = {
  id: 'note-1',
  title: 'Water',
  markdown: 'Ice is less dense than liquid water.',
  revision: 7,
  provenance: [],
  createdAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-18T12:00:00.000Z',
};

it('creates an exact edit against the current note', () => {
  expect(
    noteProposalFromCandidate(note, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_constraint',
      mode: 'replace',
      oldText: 'liquid water',
      newText: 'liquid water at the same temperature',
      reason: 'Adds the missing constraint.',
    }),
  ).toMatchObject({ noteId: 'note-1', baseRevision: 7, oldText: 'liquid water' });
});

it('omits invalid, duplicate, and empty new-note proposals', () => {
  expect(
    noteProposalFromCandidate(note, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_decision',
      oldText: 'liquid water',
      newText: 'liquid water at the same temperature',
      reason: 'Missing edit mode.',
    }),
  ).toBeNull();
  expect(
    noteProposalFromCandidate(note, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'missing',
      newText: 'replacement',
      reason: 'Update.',
    }),
  ).toBeNull();
  expect(
    noteProposalFromCandidate(note, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: note.markdown,
      newText: note.markdown,
      reason: 'No change.',
    }),
  ).toBeNull();
  expect(
    noteProposalFromCandidate(null, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'add',
      oldText: '',
      newText: '   ',
      reason: 'Empty.',
    }),
  ).toBeNull();
});

it('uses the unsaved-note identity for a new durable capture', () => {
  expect(
    noteProposalFromCandidate(null, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'add',
      oldText: '',
      newText: 'Decision: use the smaller deployment.',
      reason: 'Captures the decision.',
    }),
  ).toMatchObject({ noteId: 'unsaved-note', baseRevision: 0, oldText: '' });
});

it('keeps a valid final addition when the optional reason is blank', () => {
  expect(
    noteProposalFromCandidate(
      note,
      'turn-1',
      {
        shouldPropose: true,
        captureBasis: 'explicit_request',
        mode: 'add',
        oldText: '',
        newText: 'Add this exact selection.',
        reason: '',
      },
      true,
      { explicitCapture: true, requestedText: 'Add this exact selection.' },
    ),
  ).toMatchObject({
    oldText: '',
    newText: 'Add this exact selection.',
    reason: 'Suggested note update.',
  });
});

it('requires a user-originated capture basis before creating any proposal', () => {
  expect(
    noteProposalFromCandidate(null, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'none',
      mode: 'add',
      oldText: '',
      newText: 'Rainbows form when light is refracted, reflected, and dispersed.',
      reason: 'Summarizes the explanation.',
    }),
  ).toBeNull();
});

it('allows a validated deletion only for the final proposal', () => {
  const candidate = {
    shouldPropose: true,
    captureBasis: 'user_decision' as const,
    mode: 'replace' as const,
    oldText: note.markdown,
    newText: '',
    reason: 'Removes obsolete material.',
  };
  expect(noteProposalFromCandidate(note, 'turn-1', candidate)).toBeNull();
  expect(noteProposalFromCandidate(note, 'turn-1', candidate, true)).toMatchObject({
    oldText: note.markdown,
    newText: '',
  });
});

it('keeps one proposal identity while structured preview text grows', () => {
  const first = noteProposalFromCandidate(note, 'turn-1', {
    shouldPropose: true,
    captureBasis: 'user_decision',
    mode: 'replace',
    oldText: note.markdown,
    newText: 'Use the smaller',
  });
  const next = noteProposalFromCandidate(note, 'turn-1', {
    shouldPropose: true,
    captureBasis: 'user_decision',
    mode: 'replace',
    oldText: note.markdown,
    newText: 'Use the smaller deployment.',
  });

  expect(first).toMatchObject({ reason: 'Suggested note update.' });
  expect(next?.id).toBe(first?.id);
});

it('omits automatic proposals with more than 50 words of changed content', () => {
  const longText = Array.from({ length: 51 }, (_, index) => `word${index}`).join(' ');

  expect(
    noteProposalFromCandidate(null, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_insight',
      mode: 'add',
      oldText: '',
      newText: longText,
      reason: 'Automatic recap.',
    }),
  ).toBeNull();
});

it('invalidates an initially valid preview when the final changed text grows past the limit', () => {
  const previewText = Array.from({ length: 49 }, (_, index) => `word${index}`).join(' ');
  const finalText = `${previewText} word49 word50`;

  expect(
    noteProposalFromCandidate(null, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_insight',
      mode: 'add',
      oldText: '',
      newText: previewText,
    }),
  ).not.toBeNull();
  expect(
    noteProposalFromCandidate(
      null,
      'turn-1',
      {
        shouldPropose: true,
        captureBasis: 'user_insight',
        mode: 'add',
        oldText: '',
        newText: finalText,
        reason: 'Too long when complete.',
      },
      true,
    ),
  ).toBeNull();
});

it('counts only changed content when an edit preserves a long exact passage', () => {
  const longPrefix = Array.from({ length: 60 }, (_, index) => `existing${index}`).join(' ');
  const existing = { ...note, markdown: `${longPrefix} ending` };

  expect(
    noteProposalFromCandidate(existing, 'turn-1', {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: existing.markdown,
      newText: `${longPrefix} revised ending`,
      reason: 'Adds the decision.',
    }),
  ).toMatchObject({ newText: `${longPrefix} revised ending` });
});

it('honors a longer explicit exact capture without truncating it', () => {
  const exactText = Array.from({ length: 60 }, (_, index) => `exact${index}`).join(' ');

  expect(
    noteProposalFromCandidate(
      null,
      'turn-1',
      {
        shouldPropose: true,
        captureBasis: 'explicit_request',
        mode: 'add',
        oldText: '',
        newText: exactText,
        reason: 'Explicit capture.',
      },
      true,
      { explicitCapture: true, requestedText: exactText },
    ),
  ).toMatchObject({ newText: exactText });
});
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: supported-kind coverage is intentionally table driven in one scenario.
describe('semantic annotations', () => {
  it('only generates the six supported semantic kinds', () => {
    for (const activeKind of [
      'fact',
      'claim',
      'assumption',
      'question',
      'decision',
      'explanation',
    ]) {
      expect(annotationKindSchema.safeParse(activeKind).success).toBe(true);
    }
    for (const retiredKind of ['reasoning', 'number', 'source']) {
      expect(annotationKindSchema.safeParse(retiredKind).success).toBe(false);
    }
  });

  it('keeps exact assistant quotes, removes duplicates, and limits the result', () => {
    const text = 'The estimate is 42. Is that assumption sound?';
    const candidates = [
      { quote: 'The estimate is 42.', kind: 'claim' as const, worthHighlighting: true },
      { quote: 'The estimate is 42.', kind: 'claim' as const, worthHighlighting: true },
      { quote: 'missing quote', kind: 'fact' as const, worthHighlighting: true },
      { quote: 'Is that assumption sound?', kind: 'question' as const, worthHighlighting: true },
      ...Array.from({ length: 10 }, (_, index) => ({
        quote: '42',
        kind: index % 2 ? ('claim' as const) : ('fact' as const),
        worthHighlighting: true,
      })),
    ];

    expect(semanticAnnotations(candidates, text, 'turn')).toEqual([
      { id: expect.any(String), quote: 'The estimate is 42.', kind: 'claim', whose: 'assistant' },
      {
        id: expect.any(String),
        quote: 'Is that assumption sound?',
        kind: 'question',
        whose: 'assistant',
      },
    ]);
  });

  it('keeps substantive fixtures sparse and rejects administrative or full-answer selections', () => {
    // Marks must not accumulate into a wash across a long passage, while the
    // first substantive mark in a short one still lands.
    const longPassage = Array.from(
      { length: 6 },
      (_, index) =>
        `Sentence ${index} carries a distinct substantive claim that is worth returning to later on.`,
    ).join(' ');
    const washed = semanticAnnotations(
      longPassage
        .split('. ')
        .filter(Boolean)
        .map((sentence) => ({
          quote: sentence.endsWith('.') ? sentence : `${sentence}.`,
          kind: 'claim' as const,
          worthHighlighting: true,
        })),
      longPassage,
      'turn',
    );
    const covered = washed.reduce((total, item) => total + item.quote.length, 0);
    expect(washed.length).toBeGreaterThan(0);
    expect(covered / longPassage.length).toBeLessThan(0.45);

    const administrative =
      'I prepared the note update for you. The rollout will use the smaller deployment because it limits first-release risk. Review the details before accepting the change.';
    expect(
      semanticAnnotations(
        [
          {
            quote: 'I prepared the note update for you.',
            kind: 'decision',
            worthHighlighting: false,
          },
          {
            quote:
              'The rollout will use the smaller deployment because it limits first-release risk.',
            kind: 'decision',
            worthHighlighting: true,
          },
          { quote: administrative, kind: 'explanation', worthHighlighting: true },
        ],
        administrative,
        'turn',
      ),
    ).toEqual([
      expect.objectContaining({
        quote: 'The rollout will use the smaller deployment because it limits first-release risk.',
        kind: 'decision',
      }),
    ]);
  });

  it('allows a concise answer to be highlighted when the whole statement is substantive', () => {
    const text = 'Use the smaller deployment for the first release.';
    expect(
      semanticAnnotations(
        [{ quote: text, kind: 'decision', worthHighlighting: true }],
        text,
        'turn',
      ),
    ).toHaveLength(1);
  });
});
