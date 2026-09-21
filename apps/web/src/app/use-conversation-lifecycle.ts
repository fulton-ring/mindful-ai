import { useEffect } from 'react';
import type {
  useConversationQueries,
  useEditorState,
  usePanelState,
  useRouteState,
} from './use-conversation-shell';
import {
  cachedDismissedSuggestionIds,
  isLazyConversationAdoption,
  restoreCachedNoteDraft,
  visiblePendingSuggestions,
} from './workspace-helpers';

type LifecycleContext = {
  route: ReturnType<typeof useRouteState>;
  panel: ReturnType<typeof usePanelState>;
  editor: ReturnType<typeof useEditorState>;
  query: ReturnType<typeof useConversationQueries>;
  adoptingConversationId: { current: string | null };
};

export function useConversationLifecycle(context: LifecycleContext) {
  usePanelLifecycle(context);
  useConversationReadiness(context);
  useConversationReset(context);
  useDraftLifecycle(context);
  useNoteStateLifecycle(context);
}

function useConversationReadiness({ route, panel, query }: LifecycleContext) {
  const { activeConversationId } = route;
  const { setNoteOpen } = panel;
  const { conversationQuery } = query;
  useEffect(() => {
    if (
      activeConversationId &&
      (!conversationQuery.data || conversationQuery.data.id !== activeConversationId)
    )
      setNoteOpen(false);
  }, [activeConversationId, conversationQuery.data?.id, setNoteOpen]);
}

function usePanelLifecycle({ route, panel, query }: LifecycleContext) {
  const { activeConversationId, activeNoteId } = route;
  const { dismissedNoteConversations, setNoteOpen, setRetainedNoteChatStarted } = panel;
  const { conversation, noteConversationKey } = query;
  useEffect(() => {
    setRetainedNoteChatStarted(false);
    if (dismissedNoteConversations.has(noteConversationKey)) {
      setNoteOpen(false);
      return;
    }
    if (activeNoteId || (activeConversationId && conversation?.noteId)) setNoteOpen(true);
  }, [
    activeConversationId,
    activeNoteId,
    conversation?.noteId,
    dismissedNoteConversations,
    noteConversationKey,
    setNoteOpen,
    setRetainedNoteChatStarted,
  ]);
}

function useConversationReset({ route, editor, adoptingConversationId }: LifecycleContext) {
  const { activeConversationId, activeBranchId, activeNoteId } = route;
  const {
    setProposal,
    setProposals,
    dismissedSuggestionIds,
    setProposalRequest,
    unsavedDraftRef,
    setUnsavedDraft,
    setDecisionPending,
    setSaveState,
  } = editor;
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
  }, [
    activeBranchId,
    activeConversationId,
    activeNoteId,
    setDecisionPending,
    setProposal,
    setProposalRequest,
    setProposals,
    setSaveState,
    setUnsavedDraft,
    unsavedDraftRef,
    dismissedSuggestionIds,
    adoptingConversationId,
  ]);
}

function useDraftLifecycle({ editor, query }: Pick<LifecycleContext, 'editor' | 'query'>) {
  const { activeDocumentNoteId } = query;
  const { noteStateQuery } = query;
  const {
    setDraft,
    draftRef,
    unsavedPersistPromise,
    setSaveState,
    dismissedSuggestionIds,
    dismissSuggestionsOnSave,
  } = editor;
  const selected = activeDocumentNoteId ? noteStateQuery.data?.note : undefined;
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      draftRef.current = null;
      return;
    }
    if (unsavedPersistPromise.current && editor.unsavedDraftRef.current.markdown) return;
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
    localStorage.setItem('walden:last-note', selected.id);
  }, [
    selected?.id,
    dismissSuggestionsOnSave,
    dismissedSuggestionIds,
    draftRef,
    editor.unsavedDraftRef,
    setDraft,
    setSaveState,
    unsavedPersistPromise,
  ]);
}

function useNoteStateLifecycle({
  route,
  panel,
  editor,
  query,
}: Pick<LifecycleContext, 'route' | 'panel' | 'editor' | 'query'>) {
  const { activeBranchId } = route;
  const { noteStateQuery, noteConversationKey } = query;
  const { dismissedNoteConversations, setNoteOpen, setMobilePane } = panel;
  const {
    proposalStreaming,
    proposalRef,
    dismissedSuggestionIds,
    setProposals,
    queueOrderRef,
    draftRef,
    setDraft,
    setSaveState,
  } = editor;
  useEffect(() => {
    const state = noteStateQuery.data;
    if (!state) return;
    if (
      !proposalStreaming &&
      !['dirty', 'saving', 'error', 'conflict'].includes(editor.saveStateRef.current) &&
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
    queueOrderRef.current = state.suggestions
      .filter((item) => item.oldText === '' && item.status !== 'invalidated')
      .map((item) => ({ id: item.id, text: item.newText, accepted: item.status === 'accepted' }));
    if (pending.length && !dismissedNoteConversations.has(noteConversationKey)) {
      setNoteOpen(true);
      setMobilePane('note');
    }
  }, [
    dismissedNoteConversations,
    activeBranchId,
    dismissedSuggestionIds,
    draftRef,
    noteConversationKey,
    noteStateQuery.data,
    proposalRef,
    proposalStreaming,
    queueOrderRef,
    setDraft,
    setMobilePane,
    setNoteOpen,
    setProposals,
    setSaveState,
    editor.saveStateRef,
  ]);
}
