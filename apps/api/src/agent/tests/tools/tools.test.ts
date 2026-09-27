import { expect, it } from 'vitest';
import { noteProposalFromCandidate } from '../../note-proposals/note-proposals';

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
