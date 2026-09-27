import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react';
import { useConversationActionGroups } from '../actions/use-conversation-action-groups';
import { useConversationComposition } from './use-conversation-composition';
import { usePersonaData } from './use-persona-data';

type Composition = ReturnType<typeof useConversationComposition>;
type Actions = ReturnType<typeof useConversationActionGroups>;
type PersonaData = ReturnType<typeof usePersonaData>;
type Callback = (...args: never[]) => unknown;

/**
 * Returns an object with the same functions, whose identities never change. Each call runs the
 * function from the latest render, so consumers can hold them without going stale.
 */
function useStableCallbacks<T extends Record<string, Callback>>(callbacks: T): T {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  return useMemo(() => {
    const stable: Record<string, Callback> = {};
    for (const key of Object.keys(latest.current))
      stable[key] = (...args: never[]) => latest.current[key]!(...args);
    return stable as T;
  }, []);
}

/** Keeps the previous object while every field is unchanged. Keys must not vary between renders. */
function useShallowMemo<T extends Record<string, unknown>>(value: T): T {
  // The fields themselves are the dependencies.
  return useMemo(() => value, Object.values(value));
}

function useWorkspaceCallbacks(composition: Composition, actions: Actions, persona: PersonaData) {
  return useStableCallbacks({
    ...actions.callbacks,
    setConversation: composition.navigation.setConversation,
    changeTheme: composition.themeState.changeTheme,
    savePersona: persona.savePersona,
    deletePersona: persona.deletePersona,
    deleteEditingPersona: persona.deleteEditingPersona,
  });
}
type WorkspaceCallbacks = ReturnType<typeof useWorkspaceCallbacks>;

function shellState({ route, panel, themeState, sidebar, query, navigation }: Composition) {
  return {
    activeConversationId: route.activeConversationId,
    activeBranchId: route.activeBranchId,
    activeNoteId: route.activeNoteId,
    sidebar: panel.sidebar,
    setSidebar: panel.setSidebar,
    settingsOpen: panel.settingsOpen,
    setSettingsOpen: panel.setSettingsOpen,
    noteOpen: panel.noteOpen,
    desktop: panel.desktop,
    mobilePane: panel.mobilePane,
    setMobilePane: panel.setMobilePane,
    setRetainedNoteChatStarted: panel.setRetainedNoteChatStarted,
    notePanelRef: panel.notePanelRef,
    noteWidth: panel.noteWidth,
    theme: themeState.theme,
    navigate: navigation.navigate,
    queryClient: sidebar.queryClient,
    conversation: query.conversation,
    noteOnly: query.noteOnly,
    conversationPending: query.conversationQuery.isPending,
    conversationLoadError: query.conversationQuery.isLoadingError,
    conversationError: query.conversationQuery.error,
    retryConversation: query.conversationQuery.refetch,
  };
}

function threadListState({ sidebar }: Composition) {
  const { conversationsQuery, notesQuery, searchThreadsQuery } = sidebar;
  return {
    hasThreadOrNote:
      (conversationsQuery.data?.length ?? 0) > 0 || (notesQuery.data?.length ?? 0) > 0,
    threadsLoading: conversationsQuery.isPending,
    threadsLoadError: conversationsQuery.isError,
    retryThreads: conversationsQuery.refetch,
    retrySearch: searchThreadsQuery.refetch,
    threadSearch: sidebar.threadSearch,
    setThreadSearch: sidebar.setThreadSearch,
    searchActive: sidebar.searchActive,
    searchWaiting: sidebar.searchWaiting,
    searchFailed: sidebar.searchFailed,
    threadClock: sidebar.threadClock,
    visibleThreadGroups: sidebar.visibleThreadGroups,
    standaloneNotes: sidebar.standaloneNotes,
  };
}

function dialogState({ editor }: Composition, { mutations }: Actions, persona: PersonaData) {
  const { deleteConversation, deleteNote } = mutations;
  return {
    threadOptionsId: editor.threadOptionsId,
    setThreadOptionsId: editor.setThreadOptionsId,
    threadToDelete: editor.threadToDelete,
    setThreadToDelete: editor.setThreadToDelete,
    noteToDelete: editor.noteToDelete,
    setNoteToDelete: editor.setNoteToDelete,
    deletingThread: deleteConversation.isPending,
    threadDeleteError: deleteConversation.isError ? deleteConversation.error : null,
    confirmThreadDeletion: deleteConversation.mutate,
    resetThreadDeletion: deleteConversation.reset,
    deletingNote: deleteNote.isPending,
    noteDeleteError: deleteNote.isError ? deleteNote.error : null,
    confirmNoteDeletion: deleteNote.mutate,
    resetNoteDeletion: deleteNote.reset,
    personas: persona.personas,
    personaId: persona.personaId,
    setPersonaId: persona.setPersonaId,
    personaEditing: persona.personaEditing,
    setPersonaEditing: persona.setPersonaEditing,
  };
}

function shellCallbacks(callbacks: WorkspaceCallbacks) {
  return {
    flush: callbacks.flush,
    showNote: callbacks.showNote,
    closeNote: callbacks.closeNote,
    startChatFromNote: callbacks.startChatFromNote,
    renameConversation: callbacks.renameConversation,
    changeTheme: callbacks.changeTheme,
    savePersona: callbacks.savePersona,
    deletePersona: callbacks.deletePersona,
    deleteEditingPersona: callbacks.deleteEditingPersona,
  };
}

function noteDocumentState({ editor, query }: Composition, callbacks: WorkspaceCallbacks) {
  const { noteStateQuery } = query;
  return {
    draft: editor.draft,
    unsavedDraft: editor.unsavedDraft,
    saveState: editor.saveState,
    activeDocumentNoteId: query.activeDocumentNoteId,
    notePending: noteStateQuery.isPending,
    noteLoadError: noteStateQuery.isLoadingError,
    noteError: noteStateQuery.error,
    retryNote: noteStateQuery.refetch,
    canUndo: noteStateQuery.data?.canUndo ?? false,
    canRedo: noteStateQuery.data?.canRedo ?? false,
    notice: editor.notice,
    setNotice: editor.setNotice,
    captureRevealRange: editor.captureRevealRange,
    proposal: editor.proposal,
    proposals: editor.proposals,
    additionQueueRef: editor.queueOrderRef,
    proposalStreaming: editor.proposalStreaming,
    streamingProposalIds: editor.streamingProposalIds,
    proposalLoading: editor.proposalLoading,
    decisionPending: editor.decisionPending,
    historyPending: editor.historyPending,
    changeNote: callbacks.changeNote,
    retrySave: callbacks.retrySave,
    keepLocalDraft: callbacks.keepLocalDraft,
    loadLatestNote: callbacks.loadLatestNote,
    moveNoteHistory: callbacks.moveNoteHistory,
    acceptProposal: callbacks.acceptProposal,
    dismissSuggestion: callbacks.dismissSuggestion,
    exportNote: callbacks.exportNote,
    renameStandaloneNote: callbacks.renameStandaloneNote,
  };
}

function chatBridge(callbacks: WorkspaceCallbacks) {
  return {
    ensureConversation: callbacks.ensureConversation,
    setConversation: callbacks.setConversation,
    flush: callbacks.flush,
    applyCancelledNoteState: callbacks.applyCancelledNoteState,
    previewProposal: callbacks.previewProposal,
    completeProposals: callbacks.completeProposals,
    startProposalRequest: callbacks.startProposalRequest,
    setProposalCanceler: callbacks.setProposalCanceler,
    refreshConversationNote: callbacks.refreshConversationNote,
  };
}

export type WorkspaceShell = ReturnType<typeof shellState> &
  ReturnType<typeof threadListState> &
  ReturnType<typeof dialogState> &
  ReturnType<typeof shellCallbacks>;
export type NoteDocument = ReturnType<typeof noteDocumentState>;
export type ChatBridge = ReturnType<typeof chatBridge>;

const ShellContext = createContext<WorkspaceShell | null>(null);
const NoteDocumentContext = createContext<NoteDocument | null>(null);
const ChatBridgeContext = createContext<ChatBridge | null>(null);

function required<T>(value: T | null, name: string): T {
  if (!value) throw new Error(`${name} must be used within <WorkspaceProvider>`);
  return value;
}

/** Workspace chrome: routing, panels, sidebar lists, dialogs, personas and theme. */
export const useWorkspaceShell = () => required(useContext(ShellContext), 'useWorkspaceShell');
/** The open note: draft, saving, conflicts, history and pending suggestions. */
export const useNoteDocument = () => required(useContext(NoteDocumentContext), 'useNoteDocument');
/** Stable callbacks the chat panel uses to reach the conversation and its note. */
export const useChatBridge = () => required(useContext(ChatBridgeContext), 'useChatBridge');

export function WorkspaceProvider({
  identity,
  children,
}: {
  identity?: string;
  children: ReactNode;
}) {
  const persona = usePersonaData(identity);
  const composition = useConversationComposition(identity);
  const actions = useConversationActionGroups(composition);
  const callbacks = useWorkspaceCallbacks(composition, actions, persona);
  const shell = useShallowMemo({
    ...shellState(composition),
    ...threadListState(composition),
    ...dialogState(composition, actions, persona),
    ...shellCallbacks(callbacks),
  });
  const note = useShallowMemo(noteDocumentState(composition, callbacks));
  const bridge = useMemo(() => chatBridge(callbacks), [callbacks]);
  return (
    <ShellContext.Provider value={shell}>
      <NoteDocumentContext.Provider value={note}>
        <ChatBridgeContext.Provider value={bridge}>{children}</ChatBridgeContext.Provider>
      </NoteDocumentContext.Provider>
    </ShellContext.Provider>
  );
}
