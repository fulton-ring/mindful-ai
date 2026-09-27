import type { EditProposal, Note, ProvenanceSpan } from '@walden/contracts';
import { additionEdit } from './markdown-placement';
import { acceptQueueEdit, type QueuedAddition } from './note-queue';

type TextEdit = { from: number; to: number; insert: string };

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/**
 * Resolve an edit against the note as it stands.
 *
 * An empty `oldText` is an addition: it carries no position, and `newText` is
 * simply the text to add, placed wherever it belongs in the note as it is now.
 * That is the whole of it — additions cannot go stale, cannot conflict with one
 * another, and never need rebasing, because nothing about their position was
 * ever written down. A non-empty `oldText` is a replacement, matched exactly
 * and uniquely, and it still throws when the text it was written against is
 * gone; silently retargeting a correction would rewrite the wrong sentence.
 */
export function resolveEdit(markdown: string, oldText: string, newText: string): TextEdit {
  if (oldText.length === 0) return additionEdit(markdown, newText);

  const from = markdown.indexOf(oldText);
  if (from < 0) {
    throw new EditError('The proposed oldText was not found');
  }
  if (markdown.indexOf(oldText, from + 1) !== -1) {
    throw new EditError('The proposed oldText is ambiguous');
  }
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]
  )
    suffix += 1;
  return {
    from: from + prefix,
    to: from + oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}

function sameMetadata(a: ProvenanceSpan, b: ProvenanceSpan): boolean {
  return a.origin === b.origin && a.verbatim === b.verbatim && a.captureId === b.captureId;
}

function mergeSpans(spans: ProvenanceSpan[]): ProvenanceSpan[] {
  const sorted = spans.filter((span) => span.to > span.from).sort((a, b) => a.from - b.from);
  const merged: ProvenanceSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.to === span.from && sameMetadata(previous, span)) {
      previous.to = span.to;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Shift provenance through a user edit. Inserted text is user-authored and non-verbatim. */
export function updateProvenance(
  spans: ProvenanceSpan[],
  from: number,
  to: number,
  insert: string,
): ProvenanceSpan[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new EditError('Invalid edit range');
  }
  const delta = insert.length - (to - from);
  const next: ProvenanceSpan[] = [];
  for (const span of spans) {
    if (span.to <= from) {
      next.push({ ...span });
      continue;
    }
    if (span.from >= to) {
      next.push({ ...span, from: span.from + delta, to: span.to + delta });
      continue;
    }
    if (span.from < from) {
      next.push({ ...span, to: from, verbatim: false });
    }
    if (span.to > to) {
      next.push({ ...span, from: from + insert.length, to: span.to + delta, verbatim: false });
    }
  }
  if (insert.length > 0) {
    next.push({ from, to: from + insert.length, origin: 'user', verbatim: false });
  }
  return mergeSpans(next);
}

export function applyAgentProvenance(
  spans: ProvenanceSpan[],
  edit: TextEdit,
  captureId: string,
): ProvenanceSpan[] {
  const shifted = updateProvenance(spans, edit.from, edit.to, edit.insert).filter(
    (span) => span.to <= edit.from || span.from >= edit.from + edit.insert.length,
  );
  if (edit.insert.length > 0) {
    shifted.push({
      from: edit.from,
      to: edit.from + edit.insert.length,
      origin: 'agent',
      verbatim: true,
      captureId,
    });
  }
  return mergeSpans(shifted);
}

export function applyProposal(
  note: Note,
  proposal: EditProposal,
  /**
   * The note's additions in the order the reader saw them, accepted ones
   * included. Supplied so an addition lands where the preview showed it rather
   * than being placed as though it were the only one; without it a proposal
   * taken out of order can jump past its siblings.
   */
  queue?: readonly QueuedAddition[],
): { markdown: string; provenance: ProvenanceSpan[] } {
  if (proposal.noteId !== note.id) throw new EditError('Proposal belongs to another note');
  if (proposal.baseRevision !== note.revision) throw new EditError('Proposal is stale');
  if (proposal.status !== 'pending') throw new EditError('Proposal is no longer pending');
  const queued =
    proposal.oldText === '' && queue?.length
      ? acceptQueueEdit(note.markdown, queue, proposal.id)
      : null;
  const edit = queued ?? resolveEdit(note.markdown, proposal.oldText, proposal.newText);
  return {
    markdown: note.markdown.slice(0, edit.from) + edit.insert + note.markdown.slice(edit.to),
    provenance: applyAgentProvenance(note.provenance, edit, proposal.id),
  };
}
