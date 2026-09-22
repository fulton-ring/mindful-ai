import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import type {
  Conversation,
  ConversationSummary,
  EditProposal,
  Note,
  NoteState,
  ProvenanceSpan,
} from '@walden/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { matchesSearch, sidebarGroups } from '../../features/chat/thread-list';
import { api } from '../../lib/api';
import { track } from '../../lib/telemetry';
import { isExpiredNoteConversation, readDismissedNotePanels } from '../lifecycle/workspace-helpers';

const NO_PREVIEWS: ReadonlySet<string> = new Set();

export type ProposalRequest = {
  sourceId: string;
  noteId: string;
  phase: 'streaming' | 'loading';
  previewIds: ReadonlySet<string>;
};

export function useRouteState() {
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
  const activeNoteId = pathname.startsWith('/notes/')
    ? decodePathPart(pathname.slice('/notes/'.length))
    : null;
  const activeRoute = useRef({ conversationId: activeConversationId, branchId: activeBranchId });
  activeRoute.current = { conversationId: activeConversationId, branchId: activeBranchId };
  return { pathname, activeBranchId, activeConversationId, activeNoteId, activeRoute };
}

export function usePanelState(identity?: string) {
  const [sidebar, setSidebar] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [retainedNoteChatStarted, setRetainedNoteChatStarted] = useState(false);
  const [dismissedNoteConversations] = useState(() => readDismissedNotePanels(identity));
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 761px)').matches);
  const [mobilePane, setMobilePane] = useState<'note' | 'chat'>('chat');
  const notePanelRef = usePanelRef();
  const noteWidth = useRef(Number(localStorage.getItem('walden:note-width')) || 45);
  useEffect(() => {
    if (noteOpen) notePanelRef.current?.resize(`${noteWidth.current}%`);
    else notePanelRef.current?.collapse();
  }, [noteOpen, desktop, notePanelRef]);
  useEffect(() => {
    const media = matchMedia('(min-width: 761px)');
    const update = () => setDesktop(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return {
    sidebar,
    setSidebar,
    settingsOpen,
    setSettingsOpen,
    noteOpen,
    setNoteOpen,
    retainedNoteChatStarted,
    setRetainedNoteChatStarted,
    dismissedNoteConversations,
    desktop,
    setDesktop,
    mobilePane,
    setMobilePane,
    notePanelRef,
    noteWidth,
  };
}

export function useThemeState() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('walden:theme') === 'dark' ? 'dark' : 'light',
  );
  function changeTheme(value: 'light' | 'dark') {
    setTheme(value);
    track('theme_changed', { theme: value });
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('walden:theme', theme);
  }, [theme]);
  return { theme, setTheme, changeTheme };
}

function useDraftState() {
  const [draft, setDraft] = useState<Note | null>(null);
  const draftRef = useRef<Note | null>(null);
  const [unsavedDraft, setUnsavedDraft] = useState({
    markdown: '',
    provenance: [] as ProvenanceSpan[],
  });
  const unsavedDraftRef = useRef(unsavedDraft);
  const unsavedPersistPromise = useRef<Promise<boolean> | null>(null);
  const [saveState, setSaveStateValue] =
    useState<import('../lifecycle/workspace-helpers').SaveState>('idle');
  const saveStateRef = useRef<import('../lifecycle/workspace-helpers').SaveState>('idle');
  const setSaveState = useCallback((value: import('../lifecycle/workspace-helpers').SaveState) => {
    saveStateRef.current = value;
    setSaveStateValue(value);
  }, []);
  const timer = useRef<number | undefined>(undefined);
  const savePromise = useRef<Promise<boolean> | null>(null);
  return {
    draft,
    setDraft,
    draftRef,
    unsavedDraft,
    setUnsavedDraft,
    unsavedDraftRef,
    unsavedPersistPromise,
    saveState,
    setSaveStateValue,
    saveStateRef,
    setSaveState,
    timer,
    savePromise,
  };
}

function useProposalState() {
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const proposalRef = useRef<EditProposal | null>(null);
  proposalRef.current = proposal;
  const [proposals, setProposalsValue] = useState<EditProposal[]>([]);
  const proposalsRef = useRef<EditProposal[]>([]);
  const queueOrderRef = useRef<Array<{ id: string; text: string; accepted: boolean }>>([]);
  const setProposals = useCallback(
    (value: EditProposal[] | ((current: EditProposal[]) => EditProposal[])) => {
      const next = typeof value === 'function' ? value(proposalsRef.current) : value;
      proposalsRef.current = next;
      setProposalsValue(next);
    },
    [],
  );
  const dismissedSuggestionIds = useRef(new Set<string>());
  const [proposalRequest, setProposalRequestValue] = useState<ProposalRequest | null>(null);
  const proposalRequestRef = useRef<ProposalRequest | null>(null);
  const setProposalRequest = useCallback((request: ProposalRequest | null) => {
    proposalRequestRef.current = request;
    setProposalRequestValue(request);
  }, []);
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
  return {
    proposal,
    setProposal,
    proposalRef,
    proposals,
    setProposalsValue,
    proposalsRef,
    queueOrderRef,
    setProposals,
    dismissedSuggestionIds,
    proposalRequest,
    setProposalRequestValue,
    proposalRequestRef,
    setProposalRequest,
    proposalStreaming,
    streamingProposalIds,
    proposalLoading,
    cancelProposal,
    decisionPending,
    setDecisionPending,
    captureRevealRange,
    setCaptureRevealRange,
  };
}

function useEditorActivityState() {
  const dismissSuggestionsOnSave = useRef(new Set<string>());
  const suggestionDecisionPromise = useRef<Promise<boolean> | null>(null);
  const suggestionDecisionPreparing = useRef(false);
  const historyPromise = useRef<Promise<boolean> | null>(null);
  const historyPreparing = useRef(false);
  const [historyPending, setHistoryPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [threadToDelete, setThreadToDelete] = useState<{
    thread: ConversationSummary;
    mode: 'archive' | 'delete';
  } | null>(null);
  const [noteToDelete, setNoteToDelete] = useState<Note | null>(null);
  const [threadOptionsId, setThreadOptionsId] = useState<string | null>(null);
  const sessionStarted = useRef(false);
  const ownWordsRecorded = useRef(false);
  const conversationPromise = useRef<Promise<Conversation> | null>(null);
  const adoptingConversationId = useRef<string | null>(null);
  return {
    dismissSuggestionsOnSave,
    suggestionDecisionPromise,
    suggestionDecisionPreparing,
    historyPromise,
    historyPreparing,
    historyPending,
    setHistoryPending,
    notice,
    setNotice,
    threadToDelete,
    setThreadToDelete,
    noteToDelete,
    setNoteToDelete,
    threadOptionsId,
    setThreadOptionsId,
    sessionStarted,
    ownWordsRecorded,
    conversationPromise,
    adoptingConversationId,
  };
}

export function useEditorState() {
  const draft = useDraftState();
  const proposal = useProposalState();
  const activity = useEditorActivityState();
  const deletedNoteIds = useRef(new Set<string>());
  const deletedThreadIds = useRef(new Set<string>());
  const capturePromise = useRef<Promise<boolean> | null>(null);
  const captureAttempt = useRef<import('../actions/capture-note').CaptureAttempt | null>(null);
  return {
    ...draft,
    ...proposal,
    ...activity,
    deletedNoteIds,
    deletedThreadIds,
    capturePromise,
    captureAttempt,
  };
}

export function useSidebarQueries() {
  const queryClient = useQueryClient();
  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.conversations(),
  });
  const notesQuery = useQuery({ queryKey: ['notes'], queryFn: api.notes });
  const [threadSearch, setThreadSearch] = useState('');
  const [settledThreadSearch, setSettledThreadSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledThreadSearch(threadSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [threadSearch]);
  const searchThreadsQuery = useQuery({
    queryKey: ['conversations', 'search', settledThreadSearch],
    queryFn: () => api.conversations(settledThreadSearch),
    enabled: Boolean(settledThreadSearch),
  });
  const searchActive = Boolean(threadSearch.trim());
  const searchWaiting =
    searchActive && (threadSearch.trim() !== settledThreadSearch || searchThreadsQuery.isPending);
  const searchFailed = searchActive && !searchWaiting && searchThreadsQuery.isError;
  const listedThreads = searchActive
    ? searchWaiting || searchFailed
      ? []
      : (searchThreadsQuery.data ?? [])
    : (conversationsQuery.data ?? []);
  const [threadClock, setThreadClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setThreadClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const visibleThreadGroups = useMemo(
    () => sidebarGroups(listedThreads, threadClock),
    [listedThreads, threadClock],
  );
  const standaloneNotes = useMemo(() => {
    const linked = new Set(
      (conversationsQuery.data ?? []).flatMap((thread) => (thread.noteId ? [thread.noteId] : [])),
    );
    return (notesQuery.data ?? []).filter(
      (note) => !linked.has(note.id) && matchesSearch(threadSearch, note.title, note.markdown),
    );
  }, [conversationsQuery.data, notesQuery.data, threadSearch]);
  return {
    queryClient,
    conversationsQuery,
    notesQuery,
    threadSearch,
    setThreadSearch,
    settledThreadSearch,
    setSettledThreadSearch,
    searchThreadsQuery,
    searchActive,
    searchWaiting,
    searchFailed,
    listedThreads,
    threadClock,
    setThreadClock,
    visibleThreadGroups,
    standaloneNotes,
  };
}

export function useConversationQueries(
  route: ReturnType<typeof useRouteState>,
  panel: ReturnType<typeof usePanelState>,
) {
  const { activeConversationId, activeBranchId, activeNoteId } = route;
  const { retainedNoteChatStarted } = panel;
  const conversationQuery = useQuery({
    queryKey: ['conversation', activeConversationId, activeBranchId],
    queryFn: () => api.conversation(activeConversationId!, activeBranchId),
    enabled: Boolean(activeConversationId),
    staleTime: 20_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === activeConversationId ? previous : undefined,
  });
  const conversation = activeConversationId ? (conversationQuery.data ?? null) : null;
  const noteOnly =
    Boolean(activeNoteId) || (isExpiredNoteConversation(conversation) && !retainedNoteChatStarted);
  const activeDocumentNoteId = conversation?.noteId ?? activeNoteId;
  const noteStateQuery = useQuery({
    queryKey: ['note-state', activeDocumentNoteId],
    queryFn: () => api.noteState(activeDocumentNoteId!),
    enabled: Boolean(activeDocumentNoteId),
  });
  const noteConversationKey = activeConversationId ?? activeNoteId ?? 'new';
  return {
    conversationQuery,
    conversation,
    noteOnly,
    activeDocumentNoteId,
    noteStateQuery,
    noteConversationKey,
  };
}

function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
