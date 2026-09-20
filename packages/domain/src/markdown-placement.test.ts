import { describe, expect, it } from 'vitest';
import { additionEdit, markdownBlocks } from './markdown-placement';

describe('additionEdit', () => {
  const applied = (markdown: string, text: string) => {
    const edit = additionEdit(markdown, text);
    return markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to);
  };

  it('appends into an empty note without inventing separators', () => {
    expect(applied('', 'First line.')).toBe('First line.');
    expect(applied('  \n\n ', 'First line.')).toBe('  \n\n First line.');
  });

  it('places into a note that already has content', () => {
    const note = 'Budget is fixed at 40k.\n\nHiring pauses until June.';

    expect(applied(note, 'Budget review happens monthly.')).toBe(
      'Budget is fixed at 40k.\n\nBudget review happens monthly.\n\nHiring pauses until June.',
    );
  });

  it('gives the same answer for the same note, so preview and apply agree', () => {
    const note = '# Risks\n\nVendor lock-in.';
    expect(additionEdit(note, 'Schedule risk.')).toEqual(additionEdit(note, 'Schedule risk.'));
  });

  it('never drops existing note text', () => {
    const note = '# Plan\n\nShip in March.\n\n# Risks\n\nVendor lock-in.';
    const result = applied(note, 'Vendor contract ends in May.');
    for (const line of ['# Plan', 'Ship in March.', '# Risks', 'Vendor lock-in.'])
      expect(result).toContain(line);
    expect(result).toContain('Vendor contract ends in May.');
  });

  it('files an addition after the block it shares the most words with', () => {
    const note = 'Budget is fixed at 40k.\n\nHiring pauses until June.\n\nOffice moves in August.';

    expect(applied(note, 'Budget review happens monthly.')).toBe(
      'Budget is fixed at 40k.\n\nBudget review happens monthly.\n\nHiring pauses until June.\n\nOffice moves in August.',
    );
  });

  it('appends to the end of a section when the best match is its heading', () => {
    const note = '# Risks\n\nVendor lock-in.\n\nKey-person risk.\n\n# Budget\n\nFixed at 40k.';

    expect(applied(note, 'Schedule risk from the August move.')).toBe(
      '# Risks\n\nVendor lock-in.\n\nKey-person risk.\n\nSchedule risk from the August move.\n\n# Budget\n\nFixed at 40k.',
    );
  });

  it('inserts, so two additions beside the same block never conflict', () => {
    // A zero-width edit says an addition rewrites nothing. Modelling it as a
    // block replacement made siblings look like they overlapped, and the
    // projection dropped both.
    const note = 'Budget is fixed at 40k.';
    const first = additionEdit(note, 'Budget review happens monthly.');
    const second = additionEdit(note, 'Budget is reviewed by finance.');

    expect(first.from).toBe(first.to);
    expect(second.from).toBe(second.to);
  });

  it('appends at the end when nothing in the note is related', () => {
    const note = 'Budget is fixed at 40k.\n\nHiring pauses until June.';

    expect(applied(note, 'Priya runs the pilot.')).toBe(
      'Budget is fixed at 40k.\n\nHiring pauses until June.\n\nPriya runs the pilot.',
    );
  });
});
