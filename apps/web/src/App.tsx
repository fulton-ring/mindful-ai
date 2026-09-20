import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker, useNavigate, useRouterState } from '@tanstack/react-router';
import type {
  AppConfig,
  Conversation,
  ConversationSummary,
  EditProposal,
  Note,
  NoteState,
  Persona,
  ProvenanceSpan,
} from '@walden/contracts';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { acceptQueueEdit, applyProposal, resolveEdit } from '@walden/domain';
import {
  ChevronLeft,
  Download,
  Menu,
  Moon,
  Redo2,
  Settings,
  Sun,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { ChatPanel } from './features/chat/ChatPanel';
import { DeleteThreadDialog } from './features/chat/DeleteThreadDialog';
import { filterThreads, groupThreads } from './features/chat/thread-list';
import { additionQueue } from './features/notes/pending-projection';
import { proposalStillApplies } from './features/notes/proposal-scope';
import { PersonaEditor } from './features/personas/PersonaEditor';
import { ConversationPrivacy } from './features/settings/ConversationPrivacy';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { ApiError, api } from './lib/api';
import { id } from './lib/ids';
import { productSessionId, track } from './lib/telemetry';

const NotesEditor = lazy(() =>
  import('./features/notes/NotesEditor').then(({ NotesEditor }) => ({ default: NotesEditor })),
);

type ProposalRequest = {
  sourceId: string;
  noteId: string;
  phase: 'streaming' | 'loading';
  previewIds: ReadonlySet<string>;
};
const NO_PREVIEWS: ReadonlySet<string> = new Set();

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';
type CachedNoteDraft = {
  version: 1;
  baseRevision: number;
  markdown: string;
  provenance: ProvenanceSpan[];
  dismissedSuggestionIds?: string[];
};
const LAST_NOTE = 'walden:last-note';
const SIDEBAR_WIDTH = 'walden:sidebar-width';
function personaStorageKey(identity: string) {
  return `walden:persona:${identity}`;
}
function readStoredPersona(identity?: string): string {
  if (!identity) return '';
  try {
    return localStorage.getItem(personaStorageKey(identity)) ?? '';
  } catch {
    return '';
  }
}
function writeStoredPersona(identity: string | undefined, value: string) {
  if (!identity) return;
  try {
    if (value) localStorage.setItem(personaStorageKey(identity), value);
    else localStorage.removeItem(personaStorageKey(identity));
  } catch {
    // Private browsing and storage quotas must not block the workspace.
  }
}
export function readDismissedNotePanels(identity?: string): Set<string> {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(`walden:closed-notes:${identity ?? ''}`) ?? '[]',
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
    sessionStorage.setItem(`walden:closed-notes:${identity ?? ''}`, JSON.stringify([...dismissed]));
  } catch {
    // Retain in-memory dismissals if browser storage is unavailable.
  }
}
function threadError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/conversation/gi, 'thread') : fallback;
}
function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  return pending ? pending : true;
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

export function App({
  config,
  authControls,
  identity,
}: {
  config: AppConfig;
  authControls?: ReactNode;
  identity?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeBranchId = useRouterState({
    select: (state) =>
      typeof (state.location.search as { branch?: unknown }).branch === 'string'
        ? ((state.location.search as { branch: string }).branch ?? null)
        : null,
  });
  const activeConversationId = pathname.startsWith('/conversations/')
    ? decodePathPart(pathname.slice('/conversations/'.length))
    : null;
  const activeRoute = useRef({ conversationId: activeConversationId, branchId: activeBranchId });
  activeRoute.current = { conversationId: activeConversationId, branchId: activeBranchId };
  const personasQuery = useQuery({ queryKey: ['personas'], queryFn: api.personas, retry: false });
  const [sidebar, setSidebar] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [dismissedNoteConversations] = useState(() => readDismissedNotePanels(identity));
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 761px)').matches);
  const [mobilePane, setMobilePane] = useState<'note' | 'chat'>('chat');
  const notePanelRef = usePanelRef();
  const noteWidth = useRef(Number(localStorage.getItem('walden:note-width')) || 45);
  useEffect(() => {
    if (noteOpen) notePanelRef.current?.resize(`${noteWidth.current}%`);
    else notePanelRef.current?.collapse();
  }, [noteOpen, desktop, notePanelRef]);

  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('walden:theme') === 'dark' ? 'dark' : 'light',
  );
  function changeTheme(value: 'light' | 'dark') {
    setTheme(value);
    track('theme_changed', { theme: value });
  }
  const [draft, setDraft] = useState<Note | null>(null);
  const draftRef = useRef<Note | null>(null);
  const [unsavedDraft, setUnsavedDraft] = useState({
    markdown: '',
    provenance: [] as ProvenanceSpan[],
  });
  const unsavedDraftRef = useRef(unsavedDraft);
  const unsavedPersistPromise = useRef<Promise<boolean> | null>(null);
  const [saveState, setSaveStateValue] = useState<SaveState>('idle');
  const saveStateRef = useRef<SaveState>('idle');
  const setSaveState = (value: SaveState) => {
    saveStateRef.current = value;
    setSaveStateValue(value);
  };
  const timer = useRef<number | undefined>(undefined);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const deletedNoteIds = useRef(new Set<string>());
  const deletedThreadIds = useRef(new Set<string>());
  const capturePromise = useRef<Promise<boolean> | null>(null);
  const captureAttempt = useRef<{
    conversationId: string;
    text: string;
    verbatim: boolean;
    operationId: string;
  } | null>(null);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const proposalRef = useRef<EditProposal | null>(null);
  proposalRef.current = proposal;
  const [proposals, setProposalsValue] = useState<EditProposal[]>([]);
  const proposalsRef = useRef<EditProposal[]>([]);
  const queueOrderRef = useRef<Array<{ id: string; text: string; accepted: boolean }>>([]);
  const setProposals = (value: EditProposal[] | ((current: EditProposal[]) => EditProposal[])) => {
    const next = typeof value === 'function' ? value(proposalsRef.current) : value;
    proposalsRef.current = next;
    setProposalsValue(next);
  };
  const dismissedSuggestionIds = useRef(new Set<string>());
  const [proposalRequest, setProposalRequestValue] = useState<ProposalRequest | null>(null);
  const proposalRequestRef = useRef<ProposalRequest | null>(null);
  function setProposalRequest(request: ProposalRequest | null) {
    proposalRequestRef.current = request;
    setProposalRequestValue(request);
  }
  const proposalStreaming = proposalRequest?.phase === 'streaming';
  const streamingProposalIds = proposalRequest?.previewIds ?? NO_PREVIEWS;
  const proposalLoading = proposalRequest?.phase === 'loading';
  const cancelProposal = useRef<(() => Promise<NoteState | null>) | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const [captureRevealRange, setCaptureRevealRange] = useState<{
    from: number;
    to: number;
    key: number;
  } | null>(null);
  const dismissSuggestionsOnSave = useRef(new Set<string>());
  const suggestionDecisionPromise = useRef<Promise<boolean> | null>(null);
  const suggestionDecisionPreparing = useRef(false);
  const historyPromise = useRef<Promise<boolean> | null>(null);
  const historyPreparing = useRef(false);
  const [historyPending, setHistoryPending] = useState(false);
  // Workspace remounts when the signed-in identity changes.
  const [personaId, setPersonaId] = useState(() => readStoredPersona(identity));
  useEffect(() => {
    writeStoredPersona(identity, personaId);
  }, [identity, personaId]);
  const [personaEditing, setPersonaEditing] = useState<Persona | null>(null);
  const [notice, setNotice] = useState('');
  const [threadToDelete, setThreadToDelete] = useState<ConversationSummary | null>(null);
  const sessionStarted = useRef(false);
  const ownWordsRecorded = useRef(false);
  const conversationPromise = useRef<Promise<Conversation> | null>(null);
  const adoptingConversationId = useRef<string | null>(null);
  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: api.conversations,
  });
  const [threadSearch, setThreadSearch] = useState('');
  const visibleThreadGroups = useMemo(
    () => groupThreads(filterThreads(conversationsQuery.data ?? [], threadSearch)),
    [conversationsQuery.data, threadSearch],
  );
  const conversationQuery = useQuery({
    queryKey: ['conversation', activeConversationId, activeBranchId],
    queryFn: () => api.conversation(activeConversationId!, activeBranchId),
    enabled: Boolean(activeConversationId),
    staleTime: 20_000,
    // Switching branches changes the query key. Without this the transcript
    // unmounts to "Opening thread…" every time a regenerate creates a branch,
    // which reads as the whole app reloading. Scoped to the same conversation
    // on purpose: keeping data across *threads* made `conversation` describe a
    // thread the reader had already left, and everything derived from it
    // inherited that — the note state query fetched the previous thread's note,
    // so its pending proposals rendered in the new thread, and its revision was
    // sent with the next message and rejected as a conflict.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === activeConversationId ? previous : undefined,
  });
  const conversation = activeConversationId ? (conversationQuery.data ?? null) : null;
  const noteStateQuery = useQuery({
    queryKey: ['note-state', conversation?.noteId],
    queryFn: () => api.noteState(conversation!.noteId!),
    enabled: Boolean(conversation?.noteId),
  });
  const noteConversationKey = activeConversationId ?? 'new';
  useEffect(() => {
    if (dismissedNoteConversations.has(noteConversationKey)) {
      setNoteOpen(false);
      return;
    }
    if (activeConversationId && conversation?.noteId) setNoteOpen(true);
  }, [activeConversationId, conversation?.noteId, noteConversationKey]);
  const setConversation = useCallback(
    async (value: Conversation) => {
      if (!activeConversationId && dismissedNoteConversations.delete('new')) {
        dismissedNoteConversations.add(value.id);
        writeDismissedNotePanels(identity, dismissedNoteConversations);
      }
      const cached = cacheConversationUpdate(
        queryClient,
        value,
        activeConversationId,
        activeBranchId,
        conversation?.branchId ?? null,
      );
      const summary = queryClient
        .getQueryData<ConversationSummary[]>(['conversations'])
        ?.find((thread) => thread.id === value.id);
      if (
        !summary ||
        summary.title !== value.title ||
        summary.noteId !== value.noteId ||
        summary.expiresAt !== value.expiresAt
      )
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (activeConversationId !== value.id) {
        if (!activeConversationId) adoptingConversationId.current = value.id;
        await navigate({
          to: '/conversations/$conversationId',
          params: { conversationId: value.id },
          search: { branch: undefined },
        });
      } else if (!cached) {
        await navigate({
          to: '/conversations/$conversationId',
          params: { conversationId: value.id },
          search: { branch: value.branchId },
        });
        await queryClient.invalidateQueries({
          queryKey: ['conversation', value.id, value.branchId],
          exact: true,
        });
      }
    },
    [
      activeBranchId,
      activeConversationId,
      conversation?.branchId,
      navigate,
      queryClient,
      identity,
      dismissedNoteConversations,
    ],
  );
  useEffect(() => {
    if (!conversationQuery.data) return;
    const noteId = conversationQuery.data.noteId;
    if (!noteId) localStorage.removeItem(LAST_NOTE);
  }, [conversationQuery.data?.id, conversationQuery.data?.noteId]);
  useEffect(() => {
    const adopting = isLazyConversationAdoption(
      activeConversationId,
      adoptingConversationId.current,
    );
    if (adopting) adoptingConversationId.current = null;
    if (adopting) return;
    setProposal(null);
    setProposals([]);
    dismissedSuggestionIds.current.clear();
    setProposalRequest(null);
    unsavedDraftRef.current = { markdown: '', provenance: [] };
    setUnsavedDraft(unsavedDraftRef.current);
    setDecisionPending(false);
    setSaveState('idle');
    if (!conversationQuery.data || conversationQuery.data.id !== activeConversationId) {
      setNoteOpen(false);
    }
  }, [activeConversationId, activeBranchId]);
  const selected = conversation?.noteId ? noteStateQuery.data?.note : undefined;
  const personas = personasQuery.data ?? DEFAULT_PERSONAS;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('walden:theme', theme);
  }, [theme]);
  useEffect(() => {
    const media = matchMedia('(min-width: 761px)');
    const update = () => setDesktop(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      draftRef.current = null;
      return;
    }
    if (unsavedPersistPromise.current && unsavedDraftRef.current.markdown) return;
    const storageKey = `walden:draft:${selected.id}`;
    const stored = sessionStorage.getItem(storageKey);
    const restored = restoreCachedNoteDraft(selected, stored);
    dismissedSuggestionIds.current.clear();
    dismissSuggestionsOnSave.current.clear();
    if (stored && restored.state === 'idle') sessionStorage.removeItem(storageKey);
    else {
      for (const id of cachedDismissedSuggestionIds(stored)) {
        dismissedSuggestionIds.current.add(id);
        dismissSuggestionsOnSave.current.add(id);
      }
    }
    setDraft(restored.draft);
    draftRef.current = restored.draft;
    setSaveState(restored.state);
    localStorage.setItem(LAST_NOTE, selected.id);
  }, [selected?.id]);
  useEffect(() => {
    const state = noteStateQuery.data;
    if (!state) return;
    if (
      !proposalStreaming &&
      !['dirty', 'saving', 'error', 'conflict'].includes(saveStateRef.current) &&
      draftRef.current?.revision !== state.note.revision
    ) {
      draftRef.current = state.note;
      setDraft(state.note);
      setSaveState('saved');
    }
    const pending = visiblePendingSuggestions(
      state.suggestions,
      proposalRef.current,
      dismissedSuggestionIds.current,
    );
    setProposals(pending);
    // Accepted additions anchor the placement of pending siblings.
    queueOrderRef.current = state.suggestions
      .filter((item) => item.oldText === '' && item.status !== 'invalidated')
      .map((item) => ({
        id: item.id,
        text: item.newText,
        accepted: item.status === 'accepted',
      }));
    if (pending.length && !dismissedNoteConversations.has(noteConversationKey)) {
      setNoteOpen(true);
      setMobilePane('note');
    }
  }, [noteStateQuery.data, proposalStreaming, noteConversationKey, activeBranchId]);
  const doSave = useCallback(async () => {
    if (suggestionDecisionPromise.current) await suggestionDecisionPromise.current;
    if (savePromise.current) return savePromise.current;
    const current = draftRef.current;
    if (!current || !['dirty', 'error'].includes(saveStateRef.current))
      return saveStateRef.current !== 'conflict';
    setSaveState('saving');
    const operationId = id('save');
    const dismissedSuggestionIdsForSave = [...dismissSuggestionsOnSave.current];
    const scope: NoteMutationScope = {
      ...activeRoute.current,
      noteId: current.id,
    };
    let running: Promise<boolean>;
    running = api
      .saveNote(
        current,
        operationId,
        current.markdown,
        current.provenance,
        undefined,
        dismissedSuggestionIdsForSave,
      )
      .then(async (result) => {
        const latest = draftRef.current;
        if (
          deletedNoteIds.current.has(current.id) ||
          !noteMutationBelongsToRoute(
            scope,
            activeRoute.current.conversationId,
            activeRoute.current.branchId,
            latest?.id ?? null,
          )
        )
          return false;
        for (const suggestionId of dismissedSuggestionIdsForSave) {
          dismissSuggestionsOnSave.current.delete(suggestionId);
          dismissedSuggestionIds.current.delete(suggestionId);
        }
        const saved =
          'id' in result
            ? result
            : { ...current, revision: result.revision, updatedAt: new Date().toISOString() };
        if (
          latest &&
          (latest.markdown !== current.markdown || latest.provenance !== current.provenance)
        ) {
          const rebased = { ...latest, revision: saved.revision, updatedAt: saved.updatedAt };
          draftRef.current = rebased;
          setDraft(rebased);
          setSaveState('dirty');
          sessionStorage.setItem(
            `walden:draft:${rebased.id}`,
            JSON.stringify({
              version: 1,
              baseRevision: rebased.revision,
              markdown: rebased.markdown,
              provenance: rebased.provenance,
              dismissedSuggestionIds: [...dismissSuggestionsOnSave.current],
            } satisfies CachedNoteDraft),
          );
          return true;
        }
        draftRef.current = saved;
        setDraft(saved);
        setSaveState('saved');
        void queryClient.invalidateQueries({ queryKey: ['note-state', current.id] });
        sessionStorage.removeItem(`walden:draft:${current.id}`);
        return true;
      })
      .catch((error) => {
        if (
          deletedNoteIds.current.has(current.id) ||
          !noteMutationBelongsToRoute(
            scope,
            activeRoute.current.conversationId,
            activeRoute.current.branchId,
            draftRef.current?.id ?? null,
          )
        )
          return false;
        setSaveState(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
        return false;
      })
      .finally(() => {
        if (savePromise.current === running) {
          savePromise.current = null;
          if (saveStateRef.current === 'dirty') void doSave();
        }
      });
    savePromise.current = running;
    return running;
  }, [queryClient]);
  async function flush(allowConflict = false): Promise<number | null | false> {
    if (suggestionDecisionPromise.current && !(await suggestionDecisionPromise.current))
      return false;
    if (historyPromise.current && !(await historyPromise.current)) return false;
    if (!(await waitForPendingCapture(capturePromise.current))) return false;
    if (allowConflict && saveStateRef.current === 'conflict')
      return draftRef.current?.revision ?? null;
    const result = await flushNoteDraft();
    if (allowConflict && result === false && saveStateRef.current === 'conflict')
      return draftRef.current?.revision ?? null;
    return result;
  }
  // Placement retries must save typing without waiting on their own capture promise.
  async function flushNoteDraft(): Promise<number | null | false> {
    if (timer.current) window.clearTimeout(timer.current);
    if (
      !draftRef.current &&
      unsavedDraftRef.current.markdown &&
      !(await (unsavedPersistPromise.current ?? persistUnsavedDraft()))
    )
      return false;
    if (!draftRef.current) return null;
    let okay = await (savePromise.current ?? doSave());
    while (okay && (saveStateRef.current === 'dirty' || savePromise.current)) {
      okay = await (savePromise.current ?? doSave());
    }
    return okay ? draftRef.current.revision : false;
  }
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (
        shouldBypassLazyConversationBlock(
          current.pathname,
          next.pathname,
          adoptingConversationId.current,
        )
      )
        return false;
      return (await flush(true)) === false;
    },
    enableBeforeUnload: () =>
      ['dirty', 'saving', 'error', 'conflict'].includes(saveStateRef.current),
  });
  function updateDraft(markdown: string, provenance: ProvenanceSpan[], userChange = true) {
    if (!draftRef.current) return;
    const previous = draftRef.current;
    const conflicted = saveStateRef.current === 'conflict';
    const next = { ...draftRef.current, markdown, provenance };
    draftRef.current = next;
    setDraft(next);
    setSaveState(conflicted ? 'conflict' : 'dirty');
    if (!sessionStarted.current) {
      sessionStarted.current = true;
      void api
        .event({
          kind: 'session_started',
          sessionId: productSessionId(),
          metadata: { startsFromExisting: previous.markdown.length > 0 },
        })
        .catch(() => undefined);
    }
    if (userChange && !ownWordsRecorded.current) {
      ownWordsRecorded.current = true;
      void api
        .event({
          kind: 'own_words_saved',
          sessionId: productSessionId(),
          metadata: { noteId: next.id },
        })
        .catch(() => undefined);
    }
    sessionStorage.setItem(
      `walden:draft:${next.id}`,
      JSON.stringify({
        version: 1,
        baseRevision: next.revision,
        markdown,
        provenance,
        dismissedSuggestionIds: [...dismissSuggestionsOnSave.current],
      } satisfies CachedNoteDraft),
    );
    if (timer.current) window.clearTimeout(timer.current);
    if (!conflicted) timer.current = window.setTimeout(() => void doSave(), 700);
  }
  function updateUnsavedDraft(markdown: string, provenance: ProvenanceSpan[]) {
    cancelProposalRequest();
    const next = { markdown, provenance };
    unsavedDraftRef.current = next;
    setUnsavedDraft(next);
    if (timer.current) window.clearTimeout(timer.current);
    if (!markdown) {
      setSaveState('idle');
      return;
    }
    setSaveState('dirty');
    timer.current = window.setTimeout(() => void persistUnsavedDraft(), 700);
  }
  function persistUnsavedDraft(): Promise<boolean> {
    if (unsavedPersistPromise.current) return unsavedPersistPromise.current;
    const snapshot = unsavedDraftRef.current;
    if (!snapshot.markdown) return Promise.resolve(true);
    setSaveState('saving');
    const running = captureText(snapshot.markdown, false)
      .then((captured) => {
        if (!captured) {
          setSaveState('error');
          return false;
        }
        const latest = unsavedDraftRef.current;
        if (latest.markdown !== snapshot.markdown || latest.provenance !== snapshot.provenance) {
          updateDraft(latest.markdown, latest.provenance);
          unsavedDraftRef.current = { markdown: '', provenance: [] };
          setUnsavedDraft(unsavedDraftRef.current);
        } else {
          unsavedDraftRef.current = { markdown: '', provenance: [] };
          setUnsavedDraft(unsavedDraftRef.current);
        }
        return true;
      })
      .finally(() => {
        if (unsavedPersistPromise.current === running) unsavedPersistPromise.current = null;
      });
    unsavedPersistPromise.current = running;
    return running;
  }
  /**
   * The note owns the name. When a thread has one, rename the note and let the
   * thread take its title from there; an unattached thread still renames
   * itself.
   */
  async function renameConversation(value: string) {
    if (!conversation) return;
    const title = value.trim() || 'Untitled thread';
    if (title === conversation.title) return;
    // conversation.title lags the request, and writing it to the cache remounts
    // the input (its key includes the title), which fires blur again. Without
    // this, one rename sent three identical PATCHes.
    if (renameRequested.current?.id === conversation.id && renameRequested.current.title === title)
      return;
    renameRequested.current = { id: conversation.id, title };
    const noteId = conversation.noteId;
    try {
      if (noteId) {
        const renamed = await api.renameNote(noteId, title);
        cacheConversationTitle(queryClient, conversation.id, renamed.title);
        await queryClient.invalidateQueries({ queryKey: ['note-state', noteId] });
        return;
      }
      const updated = await api.renameConversation(conversation.id, title);
      cacheConversationTitle(queryClient, updated.id, updated.title);
    } catch (error) {
      if (activeRoute.current.conversationId !== conversation.id) return;
      setNotice(threadError(error, 'The note could not be renamed.'));
    }
  }
  const renameRequested = useRef<{ id: string; title: string } | null>(null);
  const deleteConversation = useMutation({
    mutationFn: (thread: ConversationSummary) => api.deleteConversation(thread.id),
    onSuccess: (_, thread) => {
      const deletedNoteId =
        thread.noteId ??
        (activeConversationId === thread.id
          ? (conversation?.noteId ?? draftRef.current?.id ?? null)
          : null);
      setThreadToDelete(null);
      deletedThreadIds.current.add(thread.id);
      track('conversation_deleted', { conversation_id: thread.id });
      if (deletedNoteId) {
        deletedNoteIds.current.add(deletedNoteId);
        sessionStorage.removeItem(`walden:draft:${deletedNoteId}`);
        queryClient.removeQueries({ queryKey: ['note-state', deletedNoteId], exact: true });
      }
      if (activeConversationId === thread.id) {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = undefined;
        savePromise.current = null;
        capturePromise.current = null;
        captureAttempt.current = null;
        unsavedPersistPromise.current = null;
        dismissSuggestionsOnSave.current.clear();
        suggestionDecisionPromise.current = null;
        historyPromise.current = null;
        draftRef.current = null;
        setDraft(null);
        unsavedDraftRef.current = { markdown: '', provenance: [] };
        setUnsavedDraft(unsavedDraftRef.current);
        setProposal(null);
        setProposals([]);
        dismissedSuggestionIds.current.clear();
        setProposalRequest(null);
        setDecisionPending(false);
        setHistoryPending(false);
        setSaveState('idle');
        void navigate({ to: '/' });
        localStorage.removeItem(LAST_NOTE);
      }
      queryClient.setQueryData(['conversations'], (all: typeof conversationsQuery.data = []) =>
        all?.filter((item) => item.id !== thread.id),
      );
      queryClient.removeQueries({ queryKey: ['conversation', thread.id], exact: true });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: () => undefined,
  });
  async function ensureConversation() {
    if (conversation) return conversation;
    if (conversationPromise.current) return conversationPromise.current;
    if (activeConversationId) {
      const existing = await queryClient.fetchQuery({
        queryKey: ['conversation', activeConversationId, activeBranchId],
        queryFn: () => api.conversation(activeConversationId, activeBranchId),
        staleTime: 20_000,
      });
      return existing;
    }
    if (!sessionStarted.current) {
      sessionStarted.current = true;
      void api
        .event({
          kind: 'session_started',
          sessionId: productSessionId(),
          metadata: { startsFromExisting: Boolean(draft?.markdown.length) },
        })
        .catch(() => undefined);
    }
    const pending = api
      .startConversation()
      .then(async (value) => {
        await setConversation(value);
        return value;
      })
      .finally(() => {
        conversationPromise.current = null;
      });
    conversationPromise.current = pending;
    return pending;
  }
  function applyNoteState(state: NoteState, authoritative = false) {
    if (deletedNoteIds.current.has(state.note.id)) return;
    queryClient.setQueryData(['note-state', state.note.id], state);
    if (authoritative || !['dirty', 'saving', 'error', 'conflict'].includes(saveStateRef.current)) {
      draftRef.current = state.note;
      setDraft(state.note);
      setSaveState('saved');
    }
    const active = proposalRef.current;
    const pending = visiblePendingSuggestions(
      state.suggestions,
      active,
      dismissedSuggestionIds.current,
    );
    setProposals(pending);
    // Accepted additions anchor the placement of pending siblings.
    queueOrderRef.current = state.suggestions
      .filter((item) => item.oldText === '' && item.status !== 'invalidated')
      .map((item) => ({
        id: item.id,
        text: item.newText,
        accepted: item.status === 'accepted',
      }));
    if (active && !pending.some((item) => item.id === active.id)) setProposal(null);
  }
  function applyCancelledNoteState(state: NoteState, conversationId: string, branchId: string) {
    if (
      activeRoute.current.conversationId !== conversationId ||
      activeRoute.current.branchId !== branchId
    )
      return;
    const current =
      queryClient.getQueryData<Conversation>(['conversation', conversationId, branchId]) ??
      (conversation?.id === conversationId ? conversation : null);
    if (current && current.noteId !== state.note.id) {
      cacheConversationUpdate(
        queryClient,
        { ...current, noteId: state.note.id },
        activeConversationId,
        activeBranchId,
        current.branchId,
      );
      queryClient.setQueryData<ConversationSummary[]>(['conversations'], (items = []) =>
        items.map((item) =>
          item.id === conversationId ? { ...item, noteId: state.note.id } : item,
        ),
      );
    }
    applyNoteState(state);
  }
  // Use the visible addition queue so acceptance preserves preview placement.
  function acceptedMarkdown(markdown: string, keepId: string): string | undefined {
    const edit = acceptQueueEdit(
      markdown,
      additionQueue(proposalsRef.current, queueOrderRef.current),
      keepId,
    );
    if (!edit) return undefined;
    return markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to);
  }

  async function decideSuggestion(value: EditProposal, decision: 'accept' | 'reject') {
    if (suggestionDecisionPromise.current) return suggestionDecisionPromise.current;
    if (suggestionDecisionPreparing.current) return false;
    suggestionDecisionPreparing.current = true;
    setDecisionPending(true);
    const flushed = await flush();
    const current = draftRef.current;
    if (
      flushed === false ||
      !current ||
      current.id !== value.noteId ||
      !proposalsRef.current.some((item) => item.id === value.id)
    ) {
      suggestionDecisionPreparing.current = false;
      setDecisionPending(false);
      return false;
    }
    if (decision === 'reject') {
      dismissedSuggestionIds.current.add(value.id);
      setProposals((items) => items.filter((item) => item.id !== value.id));
      if (proposalRef.current?.id === value.id) setProposal(null);
    }
    const scope: NoteMutationScope = {
      ...activeRoute.current,
      noteId: current.id,
    };
    const scopeIsCurrent = () =>
      noteMutationBelongsToRoute(
        scope,
        activeRoute.current.conversationId,
        activeRoute.current.branchId,
        draftRef.current?.id ?? null,
      );
    const running = api
      .decideSuggestion(
        value.noteId,
        value.id,
        decision,
        current.revision,
        id(`suggestion-${decision}`),
        decision === 'accept' ? acceptedMarkdown(current.markdown, value.id) : undefined,
      )
      .then((state) => {
        if (!scopeIsCurrent()) {
          void queryClient.invalidateQueries({ queryKey: ['note-state', scope.noteId] });
          return false;
        }
        dismissedSuggestionIds.current.delete(value.id);
        if (proposalRef.current?.id === value.id) {
          proposalRef.current = null;
          setProposal(null);
        }
        applyNoteState(state, true);
        return true;
      })
      .catch((error) => {
        if (deletedNoteIds.current.has(value.noteId) || !scopeIsCurrent()) return false;
        setNotice(error instanceof Error ? error.message : 'The suggestion could not be updated.');
        dismissedSuggestionIds.current.delete(value.id);
        setProposals((items) =>
          items.some((item) => item.id === value.id) ? items : [value, ...items],
        );
        if (proposalRef.current?.id === value.id) {
          setProposal(value);
        }
        return false;
      })
      .finally(() => {
        if (scopeIsCurrent()) setDecisionPending(false);
        if (suggestionDecisionPromise.current === running) suggestionDecisionPromise.current = null;
      });
    suggestionDecisionPromise.current = running;
    suggestionDecisionPreparing.current = false;
    return running;
  }
  async function acceptProposal(value: EditProposal) {
    const request = proposalRequestRef.current;
    if (request?.phase === 'loading' || request?.previewIds.has(value.id)) return;
    if (await decideSuggestion(value, 'accept')) {
      track('note_suggestion_accepted', { conversation_id: conversation?.id });
    }
  }
  function cancelProposalRequest() {
    const request = proposalRequestRef.current;
    if (!request) return;
    setProposalRequest(null);
    setProposals((items) => items.filter((item) => !request.previewIds.has(item.id)));
    setProposal(null);
    void cancelProposal.current?.();
  }

  function previewProposal(value: EditProposal | null, streaming: boolean, sourceId: string) {
    if (!streaming) {
      completeProposals(value ? [value] : [], sourceId);
      return;
    }
    const request = proposalRequestRef.current;
    if (!value || request?.sourceId !== sourceId || request.phase !== 'streaming') return;
    if (!proposalStillApplies(request, draftRef.current)) return;
    setProposalRequest({ ...request, previewIds: new Set([...request.previewIds, value.id]) });
    setProposal(value);
    setProposals((items) => [value, ...items.filter((item) => item.id !== value.id)]);
    if (!dismissedNoteConversations.has(noteConversationKey)) {
      setNoteOpen(true);
      setMobilePane('note');
    }
  }

  function completeProposals(values: EditProposal[], sourceId: string) {
    const request = proposalRequestRef.current;
    if (request?.sourceId !== sourceId || request.phase !== 'streaming') return;
    const current = draftRef.current;
    const resolved = proposalStillApplies(request, current)
      ? values.filter((value) => {
          try {
            resolveEdit(current?.markdown ?? '', value.oldText, value.newText);
            return true;
          } catch {
            return false;
          }
        })
      : [];
    const active = resolved.at(-1) ?? null;
    setProposal(active);
    setProposals((items) => [
      ...resolved,
      ...items.filter(
        (item) =>
          !request.previewIds.has(item.id) && !resolved.some((value) => value.id === item.id),
      ),
    ]);
    if (!active) {
      setProposalRequest(null);
      return;
    }
    const loading: ProposalRequest = { ...request, phase: 'loading', previewIds: NO_PREVIEWS };
    setProposalRequest(loading);
    void Promise.all([
      queryClient.fetchQuery({
        queryKey: ['note-state', active.noteId],
        queryFn: () => api.noteState(active.noteId),
        staleTime: 0,
      }),
      activeConversationId && conversation?.noteId !== active.noteId
        ? api.conversation(activeConversationId, activeBranchId)
        : Promise.resolve(null),
    ])
      .then(([state, refreshedConversation]) => {
        if (proposalRequestRef.current !== loading || deletedNoteIds.current.has(active.noteId))
          return;
        if (refreshedConversation)
          cacheConversationUpdate(
            queryClient,
            refreshedConversation,
            activeConversationId,
            activeBranchId,
            conversation?.branchId ?? null,
          );
        applyNoteState(state);
        if (!dismissedNoteConversations.has(noteConversationKey)) {
          setNoteOpen(true);
          setMobilePane('note');
        }
      })
      .catch((error) => {
        if (proposalRequestRef.current !== loading) return;
        setNotice(
          error instanceof Error ? error.message : 'The saved suggestions could not be loaded.',
        );
      })
      .finally(() => {
        if (proposalRequestRef.current === loading) setProposalRequest(null);
      });
  }

  function showNote() {
    track('note_opened', { conversation_id: conversation?.id });
    dismissedNoteConversations.delete(noteConversationKey);
    writeDismissedNotePanels(identity, dismissedNoteConversations);
    setNoteOpen(true);
    setMobilePane('note');
  }

  function closeNote() {
    track('note_closed', { conversation_id: conversation?.id });
    dismissedNoteConversations.add(noteConversationKey);
    writeDismissedNotePanels(identity, dismissedNoteConversations);
    setNoteOpen(false);
    setMobilePane('chat');
  }
  function captureText(text: string, verbatim: boolean): Promise<boolean> {
    if (capturePromise.current) return capturePromise.current;
    const running = performCaptureText(text, verbatim).finally(() => {
      if (capturePromise.current === running) capturePromise.current = null;
    });
    capturePromise.current = running;
    return running;
  }
  function captureError(message: string) {
    setNotice(message);
  }
  async function performCaptureText(text: string, verbatim: boolean): Promise<boolean> {
    const captureSpan = (from: number): ProvenanceSpan => ({
      from,
      to: from + text.length,
      origin: verbatim ? 'agent' : 'user',
      verbatim,
      captureId: verbatim ? id('capture') : undefined,
    });
    const current = draftRef.current;
    if (!current) {
      let targetConversationId: string | null = null;
      try {
        const targetConversation = await resolveCaptureConversation(
          conversation,
          activeConversationId,
          (conversationId) =>
            queryClient.fetchQuery({
              queryKey: ['conversation', conversationId, activeBranchId],
              queryFn: () => api.conversation(conversationId, activeBranchId),
              staleTime: 20_000,
            }),
          ensureConversation,
        );
        targetConversationId = targetConversation.id;
        const previousAttempt = captureAttempt.current;
        const operationId =
          previousAttempt?.conversationId === targetConversation.id &&
          previousAttempt.text === text &&
          previousAttempt.verbatim === verbatim
            ? previousAttempt.operationId
            : id('capture-save');
        captureAttempt.current = {
          conversationId: targetConversation.id,
          text,
          verbatim,
          operationId,
        };
        const { conversation: linked, note: saved } = await api.captureFirstNote(
          targetConversation.id,
          text,
          verbatim,
          operationId,
        );
        if (deletedThreadIds.current.has(targetConversation.id)) return false;
        captureAttempt.current = null;
        queryClient.setQueryData<NoteState>(['note-state', saved.id], {
          note: saved,
          suggestions: [],
          canUndo: false,
          canRedo: false,
        });
        await setConversation(mergeConversationAggregate(targetConversation, linked));
        setDraft(saved);
        draftRef.current = saved;
        setSaveState('saved');
      } catch (error) {
        if (targetConversationId && deletedThreadIds.current.has(targetConversationId))
          return false;
        captureError(error instanceof Error ? error.message : 'The capture could not be saved.');
        return false;
      }
      return true;
    }
    if (verbatim) {
      const targetConversationId = conversation?.id ?? activeConversationId;
      if (!targetConversationId) return false;
      const requestedNoteId = current.id;
      try {
        const result = await resolveCapturePlacement(
          draftRef.current ? () => draftRef.current : () => null,
          flushNoteDraft,
          (revision) => api.capturePlacement(targetConversationId, text, revision),
        );
        if (
          deletedNoteIds.current.has(requestedNoteId) ||
          deletedThreadIds.current.has(targetConversationId) ||
          (activeConversationId && activeConversationId !== targetConversationId)
        )
          return false;
        if (result.kind === 'already-present') {
          setNotice('Already in note.');
          return true;
        }
        if (result.kind === 'conflict') {
          captureError('Your writing changed this location. Retry to find a new place.');
          return false;
        }
        if (result.kind !== 'applied') return false;
        updateDraft(result.markdown, result.provenance, false);
        setCaptureRevealRange((previous) => ({
          from: result.from,
          to: result.to,
          key: (previous?.key ?? 0) + 1,
        }));
        return true;
      } catch (error) {
        if (deletedNoteIds.current.has(requestedNoteId)) return false;
        captureError(error instanceof Error ? error.message : 'The capture could not be placed.');
        return false;
      }
    }
    const separator = current.markdown.trim() ? '\n\n' : '';
    const from = current.markdown.length + separator.length;
    updateDraft(
      `${current.markdown}${separator}${text}`,
      [...current.provenance, captureSpan(from)],
      !verbatim,
    );
    return true;
  }
  function exportNote() {
    const markdown = draftRef.current?.markdown ?? unsavedDraftRef.current.markdown;
    try {
      const blob = new Blob([markdown], { type: 'text/markdown; charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${conversation?.title || 'note'}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The note could not be exported.');
    }
  }
  async function loadLatestNote() {
    const current = draftRef.current;
    if (!current) return;
    const scope: NoteMutationScope = { ...activeRoute.current, noteId: current.id };
    if (timer.current) window.clearTimeout(timer.current);
    try {
      const result = await noteStateQuery.refetch({ throwOnError: true });
      const remote = result.data?.note;
      if (
        !remote ||
        remote.id !== current.id ||
        !noteMutationBelongsToRoute(
          scope,
          activeRoute.current.conversationId,
          activeRoute.current.branchId,
          draftRef.current?.id ?? null,
        )
      )
        return;
      sessionStorage.removeItem(`walden:draft:${current.id}`);
      dismissSuggestionsOnSave.current.clear();
      draftRef.current = remote;
      setDraft(remote);
      setSaveState('idle');
    } catch (error) {
      if (
        !noteMutationBelongsToRoute(
          scope,
          activeRoute.current.conversationId,
          activeRoute.current.branchId,
          draftRef.current?.id ?? null,
        )
      )
        return;
      setSaveState('conflict');
      setNotice(error instanceof Error ? error.message : 'The latest note could not be loaded.');
    }
  }
  async function keepLocalDraft() {
    const current = draftRef.current;
    if (!current) return;
    const scope: NoteMutationScope = { ...activeRoute.current, noteId: current.id };
    if (timer.current) window.clearTimeout(timer.current);
    try {
      const result = await noteStateQuery.refetch({ throwOnError: true });
      const remote = result.data?.note;
      if (
        !remote ||
        remote.id !== current.id ||
        !noteMutationBelongsToRoute(
          scope,
          activeRoute.current.conversationId,
          activeRoute.current.branchId,
          draftRef.current?.id ?? null,
        )
      )
        return;
      const local = draftRef.current;
      if (!local) return;
      const rebased = { ...local, revision: remote.revision, updatedAt: remote.updatedAt };
      draftRef.current = rebased;
      setDraft(rebased);
      setSaveState('dirty');
      sessionStorage.setItem(
        `walden:draft:${rebased.id}`,
        JSON.stringify({
          version: 1,
          baseRevision: rebased.revision,
          markdown: rebased.markdown,
          provenance: rebased.provenance,
          dismissedSuggestionIds: [...dismissSuggestionsOnSave.current],
        } satisfies CachedNoteDraft),
      );
      await doSave();
    } catch (error) {
      if (
        !noteMutationBelongsToRoute(
          scope,
          activeRoute.current.conversationId,
          activeRoute.current.branchId,
          draftRef.current?.id ?? null,
        )
      )
        return;
      setSaveState('conflict');
      setNotice(error instanceof Error ? error.message : 'The latest note could not be loaded.');
    }
  }
  async function moveNoteHistory(action: 'undo' | 'redo') {
    if (historyPromise.current || historyPreparing.current) return;
    historyPreparing.current = true;
    if ((await flush()) === false || historyPromise.current) {
      historyPreparing.current = false;
      return;
    }
    const current = draftRef.current;
    if (!current) {
      historyPreparing.current = false;
      return;
    }
    const scope: NoteMutationScope = {
      ...activeRoute.current,
      noteId: current.id,
    };
    const scopeIsCurrent = () =>
      noteMutationBelongsToRoute(
        scope,
        activeRoute.current.conversationId,
        activeRoute.current.branchId,
        draftRef.current?.id ?? null,
      );
    setHistoryPending(true);
    const running = api
      .noteHistory(current.id, action, current.revision, id(action))
      .then((state) => {
        if (!scopeIsCurrent()) {
          void queryClient.invalidateQueries({ queryKey: ['note-state', scope.noteId] });
          return false;
        }
        applyNoteState(state, true);
        return true;
      })
      .catch((error) => {
        if (!scopeIsCurrent()) return false;
        setNotice(error instanceof Error ? error.message : `The note could not ${action}.`);
        return false;
      })
      .finally(() => {
        if (scopeIsCurrent()) setHistoryPending(false);
        if (historyPromise.current === running) historyPromise.current = null;
      });
    historyPromise.current = running;
    historyPreparing.current = false;
    await running;
  }
  return (
    <ResizablePanelGroup className="app-shell" orientation="horizontal" disabled={!desktop}>
      <ConversationPrivacy notice />
      <ResizablePanel
        className="sidebar-panel"
        defaultSize={`${Number(localStorage.getItem(SIDEBAR_WIDTH)) || 250}px`}
        minSize="220px"
        maxSize="360px"
        onResize={({ inPixels }) => {
          if (desktop) localStorage.setItem(SIDEBAR_WIDTH, String(Math.round(inPixels)));
        }}
      >
        <aside
          className={`note-sidebar ${sidebar ? 'open' : ''}`}
          aria-label="Threads"
          inert={!desktop && !sidebar}
        >
          <header>
            <div className="brand">
              {/* Concentric ripples: a stone dropped in the pond. Uses
                  currentColor so it inverts with the theme. */}
              <span className="brand-mark" aria-hidden>
                <svg viewBox="0 0 24 24" focusable="false">
                  <circle cx="12" cy="12" r="2.1" fill="currentColor" />
                  <circle
                    cx="12"
                    cy="12"
                    r="6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    opacity="0.72"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="9.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    opacity="0.4"
                  />
                </svg>
              </span>
              <span>Walden</span>
            </div>
            <button
              className="icon-button sidebar-close"
              aria-label="Close sidebar"
              onClick={() => setSidebar(false)}
            >
              <ChevronLeft />
            </button>
          </header>
          <section className="conversation-history" aria-label="Thread history">
            <div className="sidebar-section-heading">
              <span>Threads</span>
              <button
                className="text-button"
                onClick={async () => {
                  if ((await flush(true)) === false) return;
                  setSidebar(false);
                  void navigate({ to: '/' });
                  localStorage.removeItem(LAST_NOTE);
                  setMobilePane('chat');
                }}
              >
                New thread
              </button>
            </div>
            {(conversationsQuery.data?.length ?? 0) > 6 && (
              <input
                type="search"
                className="thread-search"
                placeholder="Search threads"
                aria-label="Search threads"
                value={threadSearch}
                onChange={(event) => setThreadSearch(event.target.value)}
              />
            )}
            {conversationsQuery.isPending && (
              <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
                Loading threads…
              </p>
            )}
            {conversationsQuery.isError && (
              <div role="alert" className="px-2 py-2 text-sm">
                <p>Couldn’t load threads.</p>
                <button
                  type="button"
                  className="text-button mt-1"
                  disabled={conversationsQuery.isFetching}
                  onClick={() => void conversationsQuery.refetch()}
                >
                  {conversationsQuery.isFetching ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            )}
            {visibleThreadGroups.length === 0 &&
              !conversationsQuery.isPending &&
              !conversationsQuery.isError && (
                <p className="thread-empty">
                  {threadSearch.trim() ? 'No threads match that search.' : 'No threads yet.'}
                </p>
              )}
            {visibleThreadGroups.map((group) => (
              <Fragment key={group.label}>
                <h2 className="thread-group">{group.label}</h2>
                {group.threads.map((item) => (
                  <div
                    className={`conversation-row ${item.id === activeConversationId ? 'active' : ''}`}
                    key={item.id}
                  >
                    <button
                      className="conversation-link"
                      aria-label={`Open thread: ${item.title}`}
                      onClick={async () => {
                        if ((await flush(true)) === false) return;
                        await queryClient.invalidateQueries({
                          queryKey: ['conversation', item.id],
                          exact: true,
                        });
                        setSidebar(false);
                        void navigate({
                          to: '/conversations/$conversationId',
                          params: { conversationId: item.id },
                          search: { branch: undefined },
                        });
                        setMobilePane('chat');
                      }}
                    >
                      {item.title || 'Untitled thread'}
                    </button>
                    <button
                      className="icon-button danger"
                      aria-label={`Delete thread: ${item.title}`}
                      disabled={deleteConversation.isPending}
                      onClick={() => {
                        deleteConversation.reset();
                        setThreadToDelete(item);
                      }}
                    >
                      <Trash2 />
                    </button>
                  </div>
                ))}
              </Fragment>
            ))}
          </section>
          <footer>
            <button onClick={() => setSettingsOpen(true)}>
              <Settings /> Settings
            </button>
            <button
              aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}
              onClick={() => changeTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? <Moon /> : <Sun />} {theme === 'light' ? 'Dark' : 'Light'}
            </button>
            {authControls && <div className="sidebar-auth-controls">{authControls}</div>}
          </footer>
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize sidebar" disabled={!desktop} />
      <ResizablePanel className="workspace-panel" minSize="420px">
        <div
          className={`app-workspace with-chat ${noteOpen ? '' : 'without-note'} mobile-${mobilePane}`}
        >
          <header className="mobile-header">
            <button
              className="icon-button"
              aria-label="Open sidebar"
              onClick={() => setSidebar(true)}
            >
              <Menu />
            </button>
            <span>{conversation?.title || 'Walden'}</span>
            <button className="text-button" onClick={mobilePane === 'note' ? closeNote : showNote}>
              {mobilePane === 'note' ? 'Chat' : 'Note'}
            </button>
          </header>
          <ResizablePanelGroup
            className="conversation-panels"
            orientation="horizontal"
            disabled={!desktop}
          >
            <ResizablePanel id="chat" className="chat-resizable-panel" minSize="30%">
              {activeConversationId && conversationQuery.isPending ? (
                <section className="chat-panel empty-state" aria-label="Thread" aria-busy="true">
                  <p>Opening thread…</p>
                </section>
              ) : activeConversationId && conversationQuery.isLoadingError ? (
                <section className="chat-panel empty-state" aria-label="Thread" role="alert">
                  <h2>Thread could not open</h2>
                  <p>
                    {conversationQuery.error instanceof Error
                      ? conversationQuery.error.message
                      : 'This thread may have expired or been deleted.'}
                  </p>
                  <div className="button-row">
                    <button onClick={() => void conversationQuery.refetch()}>Try again</button>
                    {activeBranchId && (
                      <button
                        onClick={() =>
                          void navigate({
                            to: '/conversations/$conversationId',
                            params: { conversationId: activeConversationId },
                            search: { branch: undefined },
                          })
                        }
                      >
                        Open current thread
                      </button>
                    )}
                    <button className="primary" onClick={() => void navigate({ to: '/' })}>
                      New thread
                    </button>
                  </div>
                </section>
              ) : (
                <ChatPanel
                  conversation={conversation}
                  scopeId={activeConversationId}
                  personas={personas}
                  personaId={personaId}
                  onPersona={(value) => {
                    setPersonaId(value);
                    track('persona_selected', {
                      persona_id: value,
                      conversation_id: conversation?.id,
                    });
                  }}
                  noteOpen={noteOpen}
                  onOpenNote={() => {
                    showNote();
                  }}
                  onBranch={(branch) => {
                    if (!activeConversationId || branch === conversation?.branchId) return;
                    void navigate({
                      to: '/conversations/$conversationId',
                      params: { conversationId: activeConversationId },
                      search: { branch },
                    });
                  }}
                  onEnsureConversation={ensureConversation}
                  onAdvance={() => {
                    // The server expires undecided proposals when a new user
                    // message lands, so drop the stale ghost right away instead
                    // of leaving an Accept that would fail.
                    if (conversation?.noteId)
                      void queryClient.invalidateQueries({
                        queryKey: ['note-state', conversation.noteId],
                      });
                  }}
                  onConversation={setConversation}
                  onFlush={flush}
                  onProposalStart={(sourceId) => {
                    setProposal(null);
                    setProposalRequest({
                      sourceId,
                      noteId: draftRef.current?.id ?? 'unsaved-note',
                      phase: 'streaming',
                      previewIds: NO_PREVIEWS,
                    });
                  }}
                  onProposalCancelable={(cancel) => {
                    cancelProposal.current = cancel;
                  }}
                  onProposalCancelled={applyCancelledNoteState}
                  onGhost={previewProposal}
                  onGhostBatch={completeProposals}
                />
              )}
            </ResizablePanel>
            <ResizableHandle
              aria-label="Resize note"
              disabled={!desktop || !noteOpen}
              className={noteOpen ? '' : 'hidden'}
            />
            <ResizablePanel
              id="note"
              className={`note-resizable-panel ${noteOpen ? 'is-opening' : ''}`}
              panelRef={notePanelRef}
              collapsible
              collapsedSize="0%"
              minSize="25%"
              maxSize="70%"
              defaultSize={noteOpen ? `${noteWidth.current}%` : '0%'}
              onResize={({ asPercentage }) => {
                if (desktop && noteOpen && asPercentage === 0) closeNote();
                if (desktop && noteOpen && asPercentage >= 25) {
                  noteWidth.current = asPercentage;
                  localStorage.setItem('walden:note-width', String(asPercentage));
                }
              }}
            >
              <main className="note-surface">
                {notice && (
                  <div className="notice-bar" role="status">
                    <span>{notice}</span>
                    <button onClick={() => setNotice('')}>Dismiss</button>
                  </div>
                )}
                {conversation?.noteId &&
                (noteStateQuery.isPending || noteStateQuery.isLoadingError) ? (
                  <>
                    <div className="note-toolbar">
                      <span className="note-title">{conversation.title}</span>
                      <button
                        className="icon-button"
                        aria-label="Close note"
                        title="Close note"
                        onClick={closeNote}
                      >
                        <X size={16} aria-hidden />
                      </button>
                    </div>
                    {noteStateQuery.isPending ? (
                      // A brief fetch, not an empty note. The full empty state -
                      // large glyph and heading - reads as a destination and is
                      // jarring for something that resolves in a moment.
                      <p className="panel-loading" role="status">
                        Opening your note…
                      </p>
                    ) : (
                      <Empty
                        title="Note could not open"
                        body={noteStateQuery.error?.message ?? ''}
                        action="Try again"
                        onAction={() => noteStateQuery.refetch()}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <div className="note-toolbar">
                      {conversation ? (
                        <input
                          key={`${conversation.id}:${conversation.title}`}
                          className="note-title"
                          aria-label="Thread title"
                          defaultValue={conversation.title}
                          maxLength={200}
                          onBlur={(event) => void renameConversation(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur();
                          }}
                          placeholder="Untitled thread"
                        />
                      ) : (
                        <span className="note-title">New thread</span>
                      )}
                      <div className="toolbar-actions">
                        <span className={`save-state ${saveState}`} aria-live="polite">
                          {proposals.length &&
                          !['dirty', 'saving', 'error', 'conflict'].includes(saveState)
                            ? ''
                            : {
                                idle: '',
                                dirty: 'Unsaved',
                                saving: 'Saving…',
                                saved: 'Saved',
                                error: 'Save failed',
                                conflict: 'Changed elsewhere',
                              }[saveState]}
                        </span>
                        {saveState === 'error' && (
                          <button
                            className="text-button"
                            onClick={() =>
                              void (draftRef.current ? doSave() : persistUnsavedDraft())
                            }
                          >
                            Retry
                          </button>
                        )}
                        {draft && (
                          <button
                            className="icon-button"
                            aria-label="Undo note action"
                            disabled={historyPending || !noteStateQuery.data?.canUndo}
                            onClick={() => void moveNoteHistory('undo')}
                          >
                            <Undo2 />
                          </button>
                        )}
                        {draft && (
                          <button
                            className="icon-button"
                            aria-label="Redo note action"
                            disabled={historyPending || !noteStateQuery.data?.canRedo}
                            onClick={() => void moveNoteHistory('redo')}
                          >
                            <Redo2 />
                          </button>
                        )}
                        {(draft || unsavedDraft.markdown) && (
                          <button
                            className="icon-button"
                            aria-label="Export Markdown"
                            title="Export Markdown"
                            onClick={exportNote}
                          >
                            <Download />
                          </button>
                        )}
                        <button
                          className="icon-button"
                          aria-label="Close note"
                          title="Close note"
                          onClick={closeNote}
                        >
                          <X size={16} aria-hidden />
                        </button>
                      </div>
                    </div>
                    <div className="editor-wrap">
                      {(noteOpen || draft || unsavedDraft.markdown || proposals.length > 0) && (
                        <Suspense fallback={<p role="status">Opening editor…</p>}>
                          <NotesEditor
                            key={activeConversationId ?? 'new-conversation-note'}
                            revealRange={captureRevealRange}
                            note={
                              draft ?? {
                                id: 'unsaved-note',
                                title: 'Note',
                                markdown: unsavedDraft.markdown,
                                revision: 0,
                                provenance: unsavedDraft.provenance,
                                createdAt: '',
                                updatedAt: '',
                              }
                            }
                            proposal={proposal}
                            additionQueue={queueOrderRef.current}
                            proposals={proposals}
                            proposalStreaming={proposalStreaming}
                            streamingProposalIds={streamingProposalIds}
                            onChange={(markdown, provenance) =>
                              draftRef.current
                                ? updateDraft(markdown, provenance)
                                : updateUnsavedDraft(markdown, provenance)
                            }
                            onAccept={acceptProposal}
                            onUndo={() => void moveNoteHistory('undo')}
                            onRedo={() => void moveNoteHistory('redo')}
                            onDismiss={(reason, candidate) => {
                              const target = candidate ?? proposalRef.current;
                              if (!target) return;
                              const isActive = proposalRef.current?.id === target.id;
                              if (proposalRequestRef.current?.previewIds.has(target.id)) {
                                cancelProposalRequest();
                                return;
                              }
                              track('note_suggestion_rejected', {
                                conversation_id: conversation?.id,
                              });
                              if (reason === 'typing') {
                                dismissedSuggestionIds.current.add(target.id);
                                setProposals((items) =>
                                  items.filter((item) => item.id !== target.id),
                                );
                                if (isActive) setProposal(null);
                                dismissSuggestionsOnSave.current.add(target.id);
                                const current = draftRef.current;
                                if (current)
                                  sessionStorage.setItem(
                                    `walden:draft:${current.id}`,
                                    JSON.stringify({
                                      version: 1,
                                      baseRevision: current.revision,
                                      markdown: current.markdown,
                                      provenance: current.provenance,
                                      dismissedSuggestionIds: [...dismissSuggestionsOnSave.current],
                                    } satisfies CachedNoteDraft),
                                  );
                                return;
                              }
                              void decideSuggestion(target, 'reject').then((updated) => {
                                if (updated && isActive) setProposal(null);
                              });
                            }}
                            disabled={decisionPending || historyPending || proposalLoading}
                          />
                        </Suspense>
                      )}
                      {saveState === 'conflict' && (
                        <div className="conflict-card" role="alert">
                          <strong>This note changed elsewhere.</strong>
                          <p>Choose which version to keep.</p>
                          <div className="button-row">
                            <button onClick={() => void keepLocalDraft()}>Keep my version</button>
                            <button onClick={() => void loadLatestNote()}>Use latest</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </main>
            </ResizablePanel>
          </ResizablePanelGroup>
          {personaEditing && (
            <PersonaEditor
              persona={personaEditing}
              onSave={async (value) => {
                // Built-in personas are not rows, so editing one saves a copy.
                // That copy replaces the built-in for this account; without
                // hiding the original both appear under the same name and the
                // edit looks like it created a stray duplicate.
                const replacesBuiltIn = Boolean(
                  value.id && DEFAULT_PERSONAS.some((p) => p.id === value.id),
                );
                const saved =
                  !value.id || replacesBuiltIn
                    ? await api.createPersona({
                        name: value.name,
                        icon: value.icon,
                        prompt: value.prompt,
                        brevity: value.brevity,
                        challenge: value.challenge,
                        tone: value.tone,
                        // Keeps the saved copy in the built-in's slot so the
                        // app's default persona does not shift to another one.
                        ...(replacesBuiltIn ? { replacesPersonaId: value.id } : {}),
                      })
                    : await api.updatePersona(value);
                if (replacesBuiltIn) await api.deletePersona(value.id);
                queryClient.setQueryData<Persona[]>(['personas'], (all = []) => [
                  ...all.filter(
                    (p) => p.id !== saved.id && (!replacesBuiltIn || p.id !== value.id),
                  ),
                  saved,
                ]);
                setPersonaId(saved.id);
                setPersonaEditing(null);
              }}
              onDelete={
                personas.length <= 1
                  ? undefined
                  : async () => {
                      if (!personaEditing.id) return;
                      await api.deletePersona(personaEditing.id);
                      queryClient.setQueryData<Persona[]>(['personas'], (all = []) =>
                        all.filter((p) => p.id !== personaEditing.id),
                      );
                      if (personaId === personaEditing.id) setPersonaId('');
                      setPersonaEditing(null);
                    }
              }
              onClose={() => setPersonaEditing(null)}
            />
          )}
          {threadToDelete && (
            <DeleteThreadDialog
              title={threadToDelete.title}
              pending={deleteConversation.isPending}
              error={
                deleteConversation.isError
                  ? threadError(
                      deleteConversation.error,
                      'The thread could not be deleted. Please try again.',
                    )
                  : undefined
              }
              onCancel={() => {
                deleteConversation.reset();
                setThreadToDelete(null);
              }}
              onConfirm={() => deleteConversation.mutate(threadToDelete)}
            />
          )}
          {settingsOpen && (
            <SettingsPanel
              open={!personaEditing}
              config={config}
              personas={personas}
              onEditPersona={(persona) => setPersonaEditing(persona)}
              onCreatePersona={() => {
                const template = DEFAULT_PERSONAS[0]!;
                setPersonaEditing({
                  ...template,
                  id: '',
                  revision: 0,
                  name: 'New persona',
                  icon: 'user',
                });
              }}
              onDeletePersona={async (persona) => {
                await api.deletePersona(persona.id);
                queryClient.setQueryData<Persona[]>(['personas'], (all = []) =>
                  all.filter((item) => item.id !== persona.id),
                );
                if (personaId === persona.id) setPersonaId('');
              }}
              onClose={() => setSettingsOpen(false)}
            />
          )}
          {sidebar && (
            <button
              className="sidebar-scrim"
              aria-label="Close sidebar"
              onClick={() => setSidebar(false)}
            />
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function Empty({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action?: string;
  onAction?(): void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-glyph">¶</span>
      <h1>{title}</h1>
      {body && <p>{body}</p>}
      {action && (
        <button className="primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
