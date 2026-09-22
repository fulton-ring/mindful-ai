import type { EditProposal } from '@walden/contracts';
import { acceptQueueEdit, type QueuedAddition, renderWithQueue, resolveEdit } from '@walden/domain';

export type PendingRange = {
  proposalId: string;
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  /**
   * What this proposal puts into the saved note across `sourceFrom`..`sourceTo`.
   * For an addition that is the whole chunk, blank lines and all — `from`..`to`
   * covers only the addition's own text, so it cannot be used to map positions.
   */
  insert: string;
};

export type ProjectionIssue =
  | { kind: 'invalid'; proposalId: string; message: string }
  | { kind: 'overlap'; proposalId: string; withProposalIds: string[] };

export type PendingProjection = {
  text: string;
  ranges: PendingRange[];
  issues: ProjectionIssue[];
};

type ResolvedReplacement = {
  proposalId: string;
  from: number;
  to: number;
  insert: string;
};

type AppliedReplacement = {
  baseFrom: number;
  baseTo: number;
  from: number;
  to: number;
};

/** Two rewrites of the same span genuinely conflict; additions never can. */
function overlaps(a: ResolvedReplacement, b: ResolvedReplacement): boolean {
  return a.from < b.to && b.from < a.to;
}

function resolveReplacements(
  markdown: string,
  proposals: readonly EditProposal[],
): { replacements: ResolvedReplacement[]; issues: ProjectionIssue[] } {
  const issues: ProjectionIssue[] = [];
  const replacements: ResolvedReplacement[] = [];
  for (const proposal of proposals) {
    if (proposal.oldText === '') continue;
    try {
      const edit = resolveEdit(markdown, proposal.oldText, proposal.newText);
      replacements.push({ proposalId: proposal.id, ...edit });
    } catch (cause) {
      issues.push({
        kind: 'invalid',
        proposalId: proposal.id,
        message: cause instanceof Error ? cause.message : 'The proposal could not be resolved',
      });
    }
  }
  return { replacements, issues };
}

function findOverlaps(replacements: readonly ResolvedReplacement[]): ProjectionIssue[] {
  const conflicted = new Set<string>();
  for (const [index, left] of replacements.entries())
    for (const right of replacements.slice(index + 1))
      if (overlaps(left, right)) {
        conflicted.add(left.proposalId);
        conflicted.add(right.proposalId);
      }
  return [...conflicted].map((proposalId) => ({
    kind: 'overlap',
    proposalId,
    withProposalIds: [...conflicted].filter((other) => other !== proposalId).sort(),
  }));
}

function applyReplacements(
  markdown: string,
  replacements: readonly ResolvedReplacement[],
  conflicted: ReadonlySet<string>,
): { base: string; ranges: PendingRange[]; applied: AppliedReplacement[] } {
  let base = markdown;
  let drift = 0;
  const ranges: PendingRange[] = [];
  const applied: AppliedReplacement[] = [];
  for (const replacement of replacements
    .filter((value) => !conflicted.has(value.proposalId))
    .sort((a, b) => a.from - b.from)) {
    const from = replacement.from + drift;
    base =
      base.slice(0, from) +
      replacement.insert +
      base.slice(from + (replacement.to - replacement.from));
    ranges.push({
      proposalId: replacement.proposalId,
      from,
      to: from + replacement.insert.length,
      sourceFrom: replacement.from,
      sourceTo: replacement.to,
      insert: replacement.insert,
    });
    applied.push({
      baseFrom: from,
      baseTo: from + replacement.insert.length,
      from: replacement.from,
      to: replacement.to,
    });
    drift += replacement.insert.length - (replacement.to - replacement.from);
  }
  return { base, ranges, applied };
}

function sourceOffset(
  offset: number,
  markdownLength: number,
  applied: readonly AppliedReplacement[],
): number {
  let result = offset;
  for (const replacement of applied) {
    if (replacement.baseTo <= offset)
      result += replacement.to - replacement.from - (replacement.baseTo - replacement.baseFrom);
    else if (replacement.baseFrom < offset) return replacement.to;
  }
  return Math.max(0, Math.min(result, markdownLength));
}

function shiftReplacementRanges(
  ranges: PendingRange[],
  rendered: ReturnType<typeof renderWithQueue>,
): void {
  for (const range of ranges) {
    const shift = rendered.spans
      .filter((span) => span.from <= range.from)
      .reduce((total, span) => total + span.insert.length, 0);
    range.from += shift;
    range.to += shift;
  }
}

/**
 * The addition queue to render, as one answer both the preview and accepting
 * use.
 *
 * It is the *visible* queue: additions already accepted are fixed points, and
 * the only pending ones in it are the ones the reader can actually see. A
 * sibling that is pending on the server but hidden here — dismissed, or on
 * another branch — would otherwise insert a chunk during a render and push the
 * accepted text away from where it was drawn. Deriving it once is what keeps
 * accepting from moving the suggestion.
 */
export function additionQueue(
  proposals: readonly EditProposal[],
  queueOrder: readonly { id: string; text: string; accepted: boolean }[] = [],
  visibleInserts: ReadonlyMap<string, string> = new Map(),
): QueuedAddition[] {
  const pending = new Map(
    proposals
      .filter((proposal) => proposal.oldText === '')
      .map((proposal) => [proposal.id, visibleInserts.get(proposal.id) ?? proposal.newText]),
  );
  const ordered = queueOrder.filter((item) => item.accepted || pending.has(item.id));
  const known = new Set(ordered.map((item) => item.id));
  return [
    ...ordered.map((item) => ({
      id: item.id,
      text: item.accepted ? item.text : (pending.get(item.id) ?? item.text),
      accepted: item.accepted,
    })),
    // A proposal that has not been persisted yet has no place in the order, so
    // it keeps its own at the end.
    ...[...pending]
      .filter(([id]) => !known.has(id))
      .map(([id, text]) => ({ id, text, accepted: false })),
  ];
}

export function acceptedProposalMarkdown(
  markdown: string,
  proposal: EditProposal,
  proposals: readonly EditProposal[],
  queueOrder: readonly { id: string; text: string; accepted: boolean }[] = [],
): string | null {
  try {
    const edit = proposal.oldText
      ? resolveEdit(markdown, proposal.oldText, proposal.newText)
      : acceptQueueEdit(markdown, additionQueue(proposals, queueOrder), proposal.id);
    return edit ? markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to) : null;
  } catch {
    return null;
  }
}

export function projectPendingEdits(
  markdown: string,
  proposals: readonly EditProposal[],
  visibleInserts: ReadonlyMap<string, string> = new Map(),
  /**
   * Every addition on this note in the order it was made, accepted ones
   * included. Accepted items are fixed points: a pending addition keeps its
   * place relative to one already taken, so accepting does not reorder the note
   * under the reader. Proposals missing from this list — one that has not been
   * persisted yet — keep their own order at the end.
   */
  queueOrder: readonly { id: string; text: string; accepted: boolean }[] = [],
): PendingProjection {
  const { replacements, issues } = resolveReplacements(markdown, proposals);
  const overlapIssues = findOverlaps(replacements);
  const conflicted = new Set(overlapIssues.map((issue) => issue.proposalId));
  const { base, ranges, applied } = applyReplacements(markdown, replacements, conflicted);
  const rendered = renderWithQueue(base, additionQueue(proposals, queueOrder, visibleInserts));
  shiftReplacementRanges(ranges, rendered);
  for (const span of rendered.spans) {
    // An addition inserts, so its source range is a point — but it has to be
    // the point it actually inserts at, in the saved note's own coordinates.
    // Claiming they all append meant the editor's map between the note and what
    // it renders was wrong, and typing beside a suggestion could commit the
    // suggestion and lose the typing.
    const sourceFrom = sourceOffset(span.sourceFrom, markdown.length, applied);
    ranges.push({
      proposalId: span.id,
      from: span.from,
      to: span.to,
      sourceFrom,
      sourceTo: sourceFrom,
      insert: span.insert,
    });
  }

  return {
    text: rendered.markdown,
    ranges: ranges.sort((a, b) => a.from - b.from),
    issues: [...issues, ...overlapIssues],
  };
}

function lineAt(text: string, position: number): number {
  let line = 0;
  const end = Math.max(0, Math.min(position, text.length));
  for (let index = 0; index < end; index += 1) if (text[index] === '\n') line += 1;
  return line;
}

export type CandidateOnLine =
  | { kind: 'none' }
  | { kind: 'unique'; proposalId: string }
  | { kind: 'ambiguous'; proposalIds: string[] };

export function candidateOnLine(
  projection: PendingProjection,
  selectionHead: number,
): CandidateOnLine {
  const bounds = projection.ranges.map((range) => {
    const text = projection.text.slice(range.from, range.to);
    const leadingSeparators = text.match(/^(?:[ \t]*\r?\n)+/)?.[0].length ?? 0;
    const trailingSeparators = text.match(/(?:\r?\n[ \t]*)+$/)?.[0].length ?? 0;
    return {
      ...range,
      contentFrom: Math.min(range.to, range.from + leadingSeparators),
      contentTo: Math.max(range.from, range.to - trailingSeparators),
    };
  });
  const direct = bounds.filter((range) =>
    range.contentFrom === range.contentTo
      ? selectionHead === range.contentFrom
      : selectionHead >= range.contentFrom && selectionHead < range.contentTo,
  );
  if (direct.length === 1 && direct[0]) {
    return { kind: 'unique', proposalId: direct[0].proposalId };
  }
  if (direct.length > 1) {
    return { kind: 'ambiguous', proposalIds: direct.map((range) => range.proposalId) };
  }
  const selectedLine = lineAt(projection.text, selectionHead);
  const ids = bounds
    .filter((range) => {
      const firstLine = lineAt(projection.text, range.contentFrom);
      const lastLine = lineAt(
        projection.text,
        range.contentTo > range.contentFrom ? range.contentTo - 1 : range.contentTo,
      );
      return selectedLine >= firstLine && selectedLine <= lastLine;
    })
    .map((range) => range.proposalId);
  if (ids.length === 0) return { kind: 'none' };
  if (ids.length === 1 && ids[0]) return { kind: 'unique', proposalId: ids[0] };
  return { kind: 'ambiguous', proposalIds: ids };
}
