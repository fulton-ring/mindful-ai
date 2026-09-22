import { createTool } from '@mastra/core/tools';
import type { Note } from '@walden/contracts';
import { z } from 'zod';

const OUTLINE_CHARS = 8_000;
const READ_CHARS = 4_000;

/** A compact navigation map supplied with every turn that has a note. */
export function noteOutline(note: Note): string {
  const lines = [`Note ${note.id}, revision ${note.revision}, ${note.markdown.length} characters.`];
  for (let offset = 0; offset < note.markdown.length; offset += OUTLINE_CHARS) {
    const chunk = note.markdown.slice(offset, offset + OUTLINE_CHARS);
    const headings = [...chunk.matchAll(/^#{1,6} .+$/gmu)].map(([heading]) => heading.slice(0, 90));
    const label = headings.length ? headings.slice(0, 3).join(' / ') : '(no heading)';
    lines.push(`${offset}–${Math.min(offset + OUTLINE_CHARS, note.markdown.length)}: ${label}`);
  }
  if (!note.markdown) lines.push('Empty note.');
  return lines.join('\n');
}

export function readNote(note: Note, offset: number) {
  const start = Math.max(0, Math.min(offset, note.markdown.length));
  const end = Math.min(start + READ_CHARS, note.markdown.length);
  return {
    revision: note.revision,
    offset: start,
    text: note.markdown.slice(start, end),
    nextOffset: end < note.markdown.length ? end : null,
  };
}

export function searchNote(note: Note, query: string) {
  const needle = query.trim().slice(0, 200);
  const matches: { offset: number; excerpt: string }[] = [];
  if (needle) {
    const haystack = note.markdown.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let offset = 0;
    while (matches.length < 10) {
      const found = haystack.indexOf(lowerNeedle, offset);
      if (found < 0) break;
      matches.push({
        offset: found,
        excerpt: note.markdown.slice(Math.max(0, found - 80), found + needle.length + 80),
      });
      offset = found + Math.max(1, needle.length);
    }
  }
  return { revision: note.revision, matches };
}

export function noteTools(note: Note) {
  return {
    searchNote: createTool({
      id: 'search_note',
      description:
        'Find exact text in the attached note. Results include character offsets for readNote.',
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      execute: async ({ query }) => searchNote(note, query),
    }),
    readNote: createTool({
      id: 'read_note',
      description:
        'Read up to 4000 exact characters of the attached note from a character offset. Follow nextOffset to continue.',
      inputSchema: z.object({ offset: z.number().int().nonnegative() }),
      execute: async ({ offset }) => readNote(note, offset),
    }),
  };
}
