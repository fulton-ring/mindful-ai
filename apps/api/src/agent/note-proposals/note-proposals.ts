import type { EditProposal, Note } from '@walden/contracts';
import { isRedundantAddition, markdownBlocks } from '@walden/domain';
import { stableId } from '../interventions';
import type { NoteProposalCandidate } from '../tool-schemas';

export { noteProposalBatchOutputSchema } from '../tool-schemas';

type NoteProposalPolicy = {
  explicitCapture?: boolean;
  requestedText?: string;
  /** Ids the model may legitimately claim to supersede. */
  pendingProposalIds?: readonly string[];
};

/**
 * Content-free diagnostics for rejected model proposals. Keep this structural:
 * proposal text and note contents must never enter logs.
 */
export function noteProposalValidationDiagnostics(
  note: Note | null,
  candidate: Partial<NoteProposalCandidate>,
  policy: NoteProposalPolicy = {},
) {
  const oldText = typeof candidate.oldText === 'string' ? candidate.oldText : '';
  const occurrenceCount =
    note && oldText
      ? note.markdown.split(oldText).length - 1
      : note && oldText === ''
        ? note.markdown === ''
          ? 1
          : 0
        : 0;
  return {
    shouldPropose: candidate.shouldPropose ?? null,
    mode: candidate.mode ?? null,
    oldCharacters: oldText.length,
    newCharacters: typeof candidate.newText === 'string' ? candidate.newText.length : null,
    oldEqualsNew: typeof candidate.newText === 'string' && oldText === candidate.newText,
    oldTextOccurrences: occurrenceCount,
    hasReason: typeof candidate.reason === 'string' && Boolean(candidate.reason.trim()),
    captureBasis: candidate.captureBasis ?? null,
    explicitCapture: Boolean(policy.explicitCapture),
    noteEmpty: !note?.markdown,
  };
}

type ProposalDraft = {
  oldText: string;
  newText: string;
  insertedText: string;
  reason: string;
};

function proposalReason(candidate: Partial<NoteProposalCandidate>) {
  return typeof candidate.reason === 'string' && candidate.reason.trim()
    ? candidate.reason
    : 'Suggested note update.';
}

function prepareAddition(
  candidate: Partial<NoteProposalCandidate>,
  policy: NoteProposalPolicy,
): ProposalDraft | null {
  if (candidate.oldText !== '') return null;
  const newText =
    policy.explicitCapture && policy.requestedText
      ? policy.requestedText
      : candidate.newText!.trim();
  if (!newText.trim() || candidate.oldText === newText) return null;
  return { oldText: '', newText, insertedText: newText, reason: proposalReason(candidate) };
}

function prepareReplacement(
  note: Note | null,
  candidate: Partial<NoteProposalCandidate>,
  final: boolean,
): ProposalDraft | null {
  if (
    (!candidate.newText!.trim() && !(final && note && candidate.oldText)) ||
    candidate.oldText === candidate.newText
  )
    return null;
  return {
    oldText: candidate.oldText!,
    newText: candidate.newText!,
    insertedText: '',
    reason: proposalReason(candidate),
  };
}

function prepareProposal(
  note: Note | null,
  candidate: Partial<NoteProposalCandidate>,
  final: boolean,
  policy: NoteProposalPolicy,
): ProposalDraft | null {
  if (
    candidate.shouldPropose !== true ||
    !candidate.captureBasis ||
    candidate.captureBasis === 'none'
  )
    return null;
  if (candidate.mode !== 'add' && candidate.mode !== 'replace') return null;
  if (typeof candidate.oldText !== 'string' || typeof candidate.newText !== 'string') return null;
  return candidate.mode === 'add'
    ? prepareAddition(candidate, policy)
    : prepareReplacement(note, candidate, final);
}

export function proposalDiff(oldText: string, newText: string) {
  let prefix = 0;
  let suffix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix])
    prefix += 1;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]
  )
    suffix += 1;
  return {
    prefix,
    suffix,
    insertedText: newText.slice(prefix, newText.length - suffix),
  };
}

function proposalHasUniqueAnchor(note: Note | null, oldText: string) {
  if (!oldText) return true;
  const first = note ? note.markdown.indexOf(oldText) : -1;
  return first >= 0 && note!.markdown.indexOf(oldText, first + 1) < 0;
}

function proposalIsRedundant(
  note: Note | null,
  mode: NoteProposalCandidate['mode'],
  oldText: string,
  newText: string,
  insertedText: string,
) {
  if (!note?.markdown || !insertedText.trim()) return false;
  const survivingBlocks = markdownBlocks(note.markdown).filter(
    (block) => !oldText.includes(block.text) || newText.includes(block.text),
  );
  const additions = markdownBlocks(insertedText);
  if (
    mode === 'replace' &&
    additions.some((addition) => survivingBlocks.some((block) => block.text === addition.text))
  )
    return true;
  return (
    additions.length > 0 &&
    additions.every((addition) =>
      survivingBlocks.some((block) => isRedundantAddition(block.text, addition.text)),
    )
  );
}

function proposalPassesPolicy(
  candidate: Partial<NoteProposalCandidate>,
  policy: NoteProposalPolicy,
  insertedText: string,
  diff: ReturnType<typeof proposalDiff>,
) {
  const requestedText = policy.requestedText;
  if (
    policy.explicitCapture &&
    (candidate.oldText!.length - diff.prefix - diff.suffix !== 0 ||
      (requestedText && !insertedText.includes(requestedText)))
  )
    return false;
  const changedText = insertedText.trim();
  if (
    !policy.explicitCapture &&
    candidate.mode === 'add' &&
    changedText &&
    changedText
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/u, '')
      .trim()
      .split(/\s+/u).length < 2
  )
    return false;
  if (!policy.explicitCapture && /^#{1,6}[ \t]+\S/mu.test(changedText)) return false;
  const exactRequested = Boolean(changedText && policy.requestedText?.includes(changedText));
  const changedWords = changedText ? changedText.split(/\s+/u).length : 0;
  return (
    policy.explicitCapture || exactRequested || (changedWords <= 50 && changedText.length <= 400)
  );
}

export function noteProposalFromCandidate(
  note: Note | null,
  turnId: string,
  candidate: Partial<NoteProposalCandidate>,
  final = false,
  policy: NoteProposalPolicy = {},
): EditProposal | null {
  const draft = prepareProposal(note, candidate, final, policy);
  if (!draft || !proposalHasUniqueAnchor(note, draft.oldText)) return null;
  const diff =
    candidate.mode === 'replace'
      ? proposalDiff(draft.oldText, draft.newText)
      : { prefix: 0, suffix: 0, insertedText: draft.insertedText };
  if (proposalIsRedundant(note, candidate.mode!, draft.oldText, draft.newText, diff.insertedText))
    return null;
  if (!proposalPassesPolicy(candidate, policy, diff.insertedText, diff)) return null;
  const replaces =
    typeof candidate.replaces === 'string' &&
    policy.pendingProposalIds?.includes(candidate.replaces)
      ? candidate.replaces
      : null;
  return {
    id: stableId('edit', turnId, draft.oldText),
    noteId: note?.id ?? 'unsaved-note',
    baseRevision: note?.revision ?? 0,
    oldText: draft.oldText,
    newText: draft.newText,
    reason: draft.reason,
    status: 'pending',
    ...(replaces ? { replaces } : {}),
  };
}
