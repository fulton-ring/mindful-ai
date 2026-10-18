import type { QueryClient } from '@tanstack/react-query';
import type {
  Conversation,
  ConversationSummary,
  EditProposal,
  Note,
  ProvenanceSpan,
} from '@walden/contracts';
import { applyProposal, resolveEdit } from '@walden/domain';
import { storageKeys } from '../../lib/storage-keys';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export type CachedNoteDraft = {
  version: 1;
  baseRevision: number;
  markdown: string;
  provenance: ProvenanceSpan[];
  dismissedSuggestionIds?: string[];
};

export function readStoredPersona(identity?: string): string {
  if (!identity) return '';
  try {
    return localStorage.getItem(storageKeys.persona(identity)) ?? '';
  } catch {
    return '';
  }
}

export function writeStoredPersona(identity: string | undefined, value: string) {
  if (!identity) return;
  try {
    if (value) localStorage.setItem(storageKeys.persona(identity), value);
    else localStorage.removeItem(storageKeys.persona(identity));
  } catch {
    // Private browsing and storage quotas must not block the workspace.
  }
}

export function readDismissedNotePanels(identity?: string): Set<string> {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKeys.closedNotes(identity)) ?? '[]',
    );
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function writeDismissedNotePanels(identity: string | undefined, dismissed: Set<string>) {
  try {
    sessionStorage.setItem(storageKeys.closedNotes(identity), JSON.stringify([...dismissed]));
  } catch {
    // Retain in-memory dismissals if browser storage is unavailable.
  }
}

export function readCachedDraft(noteId: string) {
  return sessionStorage.getItem(storageKeys.draft(noteId));
}

/** Keeps a note's unsaved edits for this browser session, until they are saved or discarded. */
export function writeCachedDraft(note: Note, dismissedSuggestionIds: Iterable<string>) {
  sessionStorage.setItem(
    storageKeys.draft(note.id),
    JSON.stringify({
      version: 1,
      baseRevision: note.revision,
      markdown: note.markdown,
      provenance: note.provenance,
      dismissedSuggestionIds: [...dismissedSuggestionIds],
    } satisfies CachedNoteDraft),
  );
}

export function clearCachedDraft(noteId: string) {
  sessionStorage.removeItem(storageKeys.draft(noteId));
}

export function restoreCachedNoteDraft(
  note: Note,
  stored: string | null,
): { draft: Note; state: SaveState } {
  if (!stored) return { draft: note, state: 'idle' };
  try {
    const cached = JSON.parse(stored) as Partial<CachedNoteDraft>;
    if (
      cached.version === 1 &&
      Number.isInteger(cached.baseRevision) &&
      typeof cached.markdown === 'string' &&
      Array.isArray(cached.provenance)
    ) {
      if (
        cached.markdown === note.markdown &&
        JSON.stringify(cached.provenance) === JSON.stringify(note.provenance)
      )
        return { draft: note, state: 'idle' };
      return {
        draft: {
          ...note,
          markdown: cached.markdown,
          provenance: cached.provenance,
          revision: cached.baseRevision!,
        },
        state: cached.baseRevision === note.revision ? 'dirty' : 'conflict',
      };
    }
  } catch {
    // Plain-text caches predate revision tracking and cannot be safely rebased.
  }
  if (stored === note.markdown) return { draft: note, state: 'idle' };
  return { draft: { ...note, markdown: stored }, state: 'conflict' };
}

export function cachedDismissedSuggestionIds(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const cached = JSON.parse(stored) as Partial<CachedNoteDraft>;
    return Array.isArray(cached.dismissedSuggestionIds)
      ? cached.dismissedSuggestionIds.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export function isLazyConversationAdoption(activeId: string | null, adoptingId: string | null) {
  return activeId !== null && activeId === adoptingId;
}

function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function shouldBypassLazyConversationBlock(
  currentPath: string,
  nextPath: string,
  adoptingId: string | null,
) {
  if (currentPath !== '/' || !nextPath.startsWith('/conversations/')) return false;
  return isLazyConversationAdoption(
    decodePathPart(nextPath.slice('/conversations/'.length)),
    adoptingId,
  );
}

export async function resolveCaptureConversation(
  conversation: Conversation | null,
  activeConversationId: string | null,
  load: (id: string) => Promise<Conversation>,
  ensure: () => Promise<Conversation>,
) {
  if (conversation) return conversation;
  if (activeConversationId) return load(activeConversationId);
  return ensure();
}

export async function waitForPendingCapture(pending: Promise<boolean> | null) {
  return pending ?? true;
}

export type CapturePlacementResult =
  | { kind: 'applied'; markdown: string; provenance: ProvenanceSpan[]; from: number; to: number }
  | { kind: 'already-present' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

export async function resolveCapturePlacement(
  getCurrent: () => Note | null,
  flushCurrent: () => Promise<number | null | false>,
  requestPlacement: (revision: number) => Promise<{ proposal: EditProposal | null }>,
): Promise<CapturePlacementResult> {
  const noteId = getCurrent()?.id;
  if (!noteId) return { kind: 'unavailable' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revision = await flushCurrent();
    if (revision === false) return { kind: 'unavailable' };
    const snapshot = getCurrent();
    if (!snapshot || snapshot.id !== noteId) return { kind: 'unavailable' };
    const { proposal } = await requestPlacement(snapshot.revision);
    if (!proposal) return { kind: 'already-present' };
    const latest = getCurrent();
    if (!latest || latest.id !== noteId) return { kind: 'unavailable' };
    try {
      const rebased = { ...proposal, baseRevision: latest.revision };
      const edit = resolveEdit(latest.markdown, rebased.oldText, rebased.newText);
      const applied = applyProposal(latest, rebased);
      return {
        kind: 'applied',
        ...applied,
        from: edit.from,
        to: edit.from + edit.insert.length,
      };
    } catch {
      if (attempt === 1) return { kind: 'conflict' };
    }
  }
  return { kind: 'conflict' };
}

export function visiblePendingSuggestions<T extends { id: string; status: string }>(
  suggestions: readonly T[],
  active: T | null,
  locallyDismissed: ReadonlySet<string>,
): T[] {
  const pending = suggestions.filter(
    (item) => item.status === 'pending' && !locallyDismissed.has(item.id),
  );
  if (
    active &&
    active.status === 'pending' &&
    !locallyDismissed.has(active.id) &&
    !pending.some((item) => item.id === active.id)
  )
    return [active, ...pending];
  return pending;
}

export function isExpiredNoteConversation(
  conversation: Pick<Conversation, 'noteId' | 'expiresAt'> | null,
  now: Date = new Date(),
) {
  if (!conversation?.noteId) return false;
  if (conversation.expiresAt === null) return false;
  const expiresAt = Date.parse(conversation.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

export function cacheConversationUpdate(
  queryClient: QueryClient,
  value: Conversation,
  activeConversationId: string | null,
  activeBranchId: string | null,
  currentBranchId: string | null,
): boolean {
  const changingBranch =
    activeConversationId === value.id &&
    currentBranchId !== null &&
    currentBranchId !== value.branchId;
  if (changingBranch) return false;
  queryClient.setQueryData(['conversation', value.id, value.branchId], value);
  if (!activeConversationId || activeConversationId === value.id)
    queryClient.setQueryData(['conversation', value.id, activeBranchId], value);
  return true;
}

export function mergeConversationAggregate(
  selected: Conversation,
  aggregate: Conversation,
): Conversation {
  return {
    ...selected,
    title: aggregate.title,
    noteId: aggregate.noteId,
    learningChecksEnabled: aggregate.learningChecksEnabled,
  };
}

export function cacheConversationTitle(
  queryClient: QueryClient,
  conversationId: string,
  title: string,
) {
  queryClient.setQueriesData<Conversation>(
    { queryKey: ['conversation', conversationId] },
    (current) => (current ? { ...current, title } : current),
  );
  queryClient.setQueryData<ConversationSummary[]>(['conversations'], (all) =>
    all?.map((item) => (item.id === conversationId ? { ...item, title } : item)),
  );
}

export type NoteMutationScope = {
  conversationId: string | null;
  branchId: string | null;
  noteId: string;
};

export function noteMutationBelongsToRoute(
  scope: NoteMutationScope,
  conversationId: string | null,
  branchId: string | null,
  noteId: string | null,
): boolean {
  return (
    scope.conversationId === conversationId &&
    scope.branchId === branchId &&
    scope.noteId === noteId
  );
}
