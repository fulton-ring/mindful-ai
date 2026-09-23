import type { Note } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyProposal,
  EditError,
  expiryFrom,
  isExpired,
  resolveEdit,
  updateProvenance,
} from '../note-edits';

const note = (markdown: string, revision = 4): Note => ({
  id: 'n1',
  title: 'Test',
  markdown,
  revision,
  provenance: [{ from: 0, to: markdown.length, origin: 'user', verbatim: false }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('resolveEdit', () => {
  it('uses UTF-16 offsets for astral characters', () => {
    expect(resolveEdit('A😀B', '😀', 'X')).toEqual({ from: 1, to: 3, insert: 'X' });
  });
  it('rejects missing and duplicate matches', () => {
    expect(() => resolveEdit('abc', 'z', 'x')).toThrow(EditError);
    expect(() => resolveEdit('aba', 'a', 'x')).toThrow(/ambiguous/);
  });
  const applied = (markdown: string, oldText: string, newText: string) => {
    const edit = resolveEdit(markdown, oldText, newText);
    return markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to);
  };

  it('treats an empty oldText as an addition and places it', () => {
    // An addition stores no position at all, so it is always applicable; there
    // is nothing about it that a later edit to the note could invalidate.
    expect(applied('', '', 'hello')).toBe('hello');
    expect(applied('x', '', 'hello')).toBe('x\n\nhello');
  });
  it('keeps an addition after the note it was written alongside', () => {
    // Authored when the note was empty, applied once a sibling has landed: it
    // goes after the existing text, never on top of it.
    expect(applied('First.', '', 'Second.')).toBe('First.\n\nSecond.');
  });
});

describe('proposals and provenance', () => {
  it('rejects stale proposals before applying text', () => {
    expect(() =>
      applyProposal(note('old', 2), {
        id: 'p',
        noteId: 'n1',
        baseRevision: 1,
        oldText: 'old',
        newText: 'new',
        reason: '',
        status: 'pending',
      }),
    ).toThrow(/stale/);
  });
  it('marks accepted replacement as verbatim agent text', () => {
    const result = applyProposal(note('hello world'), {
      id: 'p',
      noteId: 'n1',
      baseRevision: 4,
      oldText: 'world',
      newText: 'there',
      reason: '',
      status: 'pending',
    });
    expect(result.markdown).toBe('hello there');
    expect(result.provenance).toContainEqual({
      from: 6,
      to: 11,
      origin: 'agent',
      verbatim: true,
      captureId: 'p',
    });
  });
  it('turns touched agent text non-verbatim while preserving untouched text', () => {
    const spans = [{ from: 0, to: 5, origin: 'agent' as const, verbatim: true }];
    expect(updateProvenance(spans, 2, 3, 'X')).toEqual([
      { from: 0, to: 2, origin: 'agent', verbatim: false },
      { from: 2, to: 3, origin: 'user', verbatim: false },
      { from: 3, to: 5, origin: 'agent', verbatim: false },
    ]);
  });
});

describe('expiry', () => {
  it('expires at the deadline and creates a seven day ISO deadline', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(expiryFrom(now)).toBe('2026-01-08T00:00:00.000Z');
    expect(isExpired(expiryFrom(now), now)).toBe(false);
    expect(isExpired(expiryFrom(now), now + 7 * 24 * 60 * 60 * 1000)).toBe(true);
  });
});
