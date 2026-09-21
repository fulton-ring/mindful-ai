import type { Note } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { noteOutline, readNote, searchNote } from './note-access';

const note = (markdown: string): Note => ({
  id: 'note-1',
  title: 'Research',
  markdown,
  revision: 7,
  provenance: [],
  createdAt: 'now',
  updatedAt: 'now',
});

describe('bounded note access', () => {
  it('gives a navigable outline for a large note without copying its body', () => {
    const markdown = `# First\n${'a'.repeat(9_000)}\n# Last\nprivate ending`;
    const outline = noteOutline(note(markdown));
    expect(outline).toContain('revision 7');
    expect(outline).toContain('# First');
    expect(outline).toContain('# Last');
    expect(outline).not.toContain('private ending');
    expect(outline).not.toContain('a'.repeat(100));
  });

  it('reads exact bounded slices and finds a passage near the end', () => {
    const value = note(`${'a'.repeat(12_000)}\nUnique ending`);
    const matches = searchNote(value, 'Unique ending');
    expect(matches.matches).toHaveLength(1);
    const result = readNote(value, matches.matches[0]!.offset);
    expect(result.text).toContain('Unique ending');
    expect(result.text.length).toBeLessThanOrEqual(4_000);
    expect(result.revision).toBe(7);
  });
});
