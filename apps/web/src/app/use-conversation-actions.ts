import { useMutation } from '@tanstack/react-query';
import type { Conversation, ConversationSummary, Note, NoteState } from '@walden/contracts';
import { useRef } from 'react';
import { api } from '../lib/api';
import { productSessionId, track } from '../lib/telemetry';
import type { ConversationContext } from './conversation-context';
import {
  cacheConversationTitle,
  cacheConversationUpdate,
  visiblePendingSuggestions,
  writeDismissedNotePanels,
} from './workspace-helpers';

type ActionContext = ConversationContext & {
  identity?: string;
};

type Flush = (allowConflict?: boolean) => Promise<number | null | false>;

function deletedNoteId(
  context: ActionContext,
  thread: ConversationSummary,
  mode: 'archive' | 'delete',
) {
  if (mode !== 'delete') return null;
  return (
    thread.noteId ??
    (context.activeConversationId === thread.id
      ? (context.conversation?.noteId ?? context.draftRef.current?.id ?? null)
      : null)
  );
}

function clearDeletedNote(context: ActionContext, noteId: string) {
  context.deletedNoteIds.current.add(noteId);
  sessionStorage.removeItem(`walden:draft:${noteId}`);
  context.queryClient.removeQueries({ queryKey: ['note-state', noteId], exact: true });
  context.queryClient.setQueryData<Note[]>(['notes'], (notes) =>
    notes?.filter((item) => item.id !== noteId),
  );
}

function resetDeletedConversation(
  context: ActionContext,
  thread: ConversationSummary,
  mode: string,
) {
  if (context.timer.current) window.clearTimeout(context.timer.current);
  context.timer.current = undefined;
  context.savePromise.current = null;
  context.capturePromise.current = null;
  context.captureAttempt.current = null;
  context.unsavedPersistPromise.current = null;
  context.dismissSuggestionsOnSave.current.clear();
  context.suggestionDecisionPromise.current = null;
  context.historyPromise.current = null;
  context.draftRef.current = null;
  context.setDraft(null);
  context.unsavedDraftRef.current = { markdown: '', provenance: [] };
  context.setUnsavedDraft(context.unsavedDraftRef.current);
  context.setProposal(null);
  context.setProposals([]);
  context.dismissedSuggestionIds.current.clear();
  context.setProposalRequest(null);
  context.setDecisionPending(false);
  context.setHistoryPending(false);
  context.setSaveState('idle');
  if (mode === 'archive' && thread.noteId)
    void context.navigate({ to: '/notes/$noteId', params: { noteId: thread.noteId } });
  else void context.navigate({ to: '/' });
  localStorage.removeItem('walden:last-note');
}

function removeConversationFromCaches(context: ActionContext, thread: ConversationSummary) {
  context.queryClient.setQueryData(['conversations'], (all: ConversationSummary[] = []) =>
    all.filter((item) => item.id !== thread.id),
  );
  void context.queryClient.invalidateQueries({ queryKey: ['conversations'] });
  void context.queryClient.invalidateQueries({ queryKey: ['notes'] });
  context.queryClient.removeQueries({ queryKey: ['conversation', thread.id], exact: true });
}

function handleDeletedConversation(
  context: ActionContext,
  thread: ConversationSummary,
  mode: 'archive' | 'delete',
) {
  const noteId = deletedNoteId(context, thread, mode);
  context.setThreadToDelete(null);
  context.setThreadOptionsId(null);
  context.deletedThreadIds.current.add(thread.id);
  track(mode === 'archive' ? 'conversation_archived' : 'conversation_deleted', {
    conversation_id: thread.id,
  });
  if (noteId) clearDeletedNote(context, noteId);
  if (context.activeConversationId === thread.id) resetDeletedConversation(context, thread, mode);
  removeConversationFromCaches(context, thread);
}

function useConversationRename(context: ActionContext) {
  const renameRequested = useRef<{ id: string; title: string } | null>(null);
  const renameConversation = async (value: string) => {
    const conversation = context.conversation;
    if (!conversation) return;
    const title = value.trim() || 'Untitled thread';
    if (title === conversation.title) return;
    if (renameRequested.current?.id === conversation.id && renameRequested.current.title === title)
      return;
    renameRequested.current = { id: conversation.id, title };
    try {
      if (conversation.noteId) {
        const renamed = await api.renameNote(conversation.noteId, title);
        cacheConversationTitle(context.queryClient, conversation.id, renamed.title);
        await context.queryClient.invalidateQueries({
          queryKey: ['note-state', conversation.noteId],
        });
        return;
      }
      const updated = await api.renameConversation(conversation.id, title);
      cacheConversationTitle(context.queryClient, updated.id, updated.title);
    } catch (error) {
      if (context.activeRoute.current.conversationId === conversation.id)
        context.setNotice(
          error instanceof Error ? error.message : 'The note could not be renamed.',
        );
    }
  };
  return { renameConversation, renameRequested };
}

function useConversationDeletion(context: ActionContext, flush: Flush) {
  const deleteConversation = useMutation({
    mutationFn: async ({
      thread,
      mode,
    }: {
      thread: ConversationSummary;
      mode: 'archive' | 'delete';
    }) => {
      if (
        mode === 'archive' &&
        context.activeConversationId === thread.id &&
        (await flush(true)) === false
      )
        throw new Error('Save the note before archiving this thread.');
      return mode === 'archive'
        ? api.archiveConversation(thread.id)
        : api.deleteConversation(thread.id);
    },
    onSuccess: (_, { thread, mode }) => handleDeletedConversation(context, thread, mode),
    onError: () => undefined,
  });
  const deleteNote = useMutation({
    mutationFn: async (note: Note) => {
      if (context.activeNoteId === note.id && (await flush(true)) === false)
        throw new Error('Save the note before deleting it.');
      return api.deleteNote(note.id);
    },
    onSuccess: (_, note) => {
      context.setNoteToDelete(null);
      clearDeletedNote(context, note.id);
      if (context.activeNoteId === note.id) void context.navigate({ to: '/' });
    },
  });
  return { deleteConversation, deleteNote };
}

async function ensureConversation(context: ActionContext) {
  if (context.conversation) return context.conversation;
  if (context.conversationPromise.current) return context.conversationPromise.current;
  if (context.activeConversationId)
    return context.queryClient.fetchQuery({
      queryKey: ['conversation', context.activeConversationId, context.activeBranchId],
      queryFn: () => api.conversation(context.activeConversationId!, context.activeBranchId),
      staleTime: 20_000,
    });
  if (!context.sessionStarted.current) {
    context.sessionStarted.current = true;
    void api
      .event({
        kind: 'session_started',
        sessionId: productSessionId(),
        metadata: { startsFromExisting: Boolean(context.draft?.markdown.length) },
      })
      .catch(() => undefined);
  }
  const pending = api
    .startConversation()
    .then(async (value) => {
      await context.setConversation(value);
      return value;
    })
    .finally(() => {
      context.conversationPromise.current = null;
    });
  context.conversationPromise.current = pending;
  return pending;
}

function applyNoteState(context: ActionContext, state: NoteState, authoritative = false) {
  if (context.deletedNoteIds.current.has(state.note.id)) return;
  context.queryClient.setQueryData(['note-state', state.note.id], state);
  if (
    authoritative ||
    !['dirty', 'saving', 'error', 'conflict'].includes(context.saveStateRef.current)
  ) {
    context.draftRef.current = state.note;
    context.setDraft(state.note);
    context.setSaveState('saved');
  }
  const pending = visiblePendingSuggestions(
    state.suggestions,
    context.proposalRef.current,
    context.dismissedSuggestionIds.current,
  );
  context.setProposals(pending);
  context.queueOrderRef.current = state.suggestions
    .filter((item) => item.oldText === '' && item.status !== 'invalidated')
    .map((item) => ({ id: item.id, text: item.newText, accepted: item.status === 'accepted' }));
  if (
    context.proposalRef.current &&
    !pending.some((item) => item.id === context.proposalRef.current?.id)
  )
    context.setProposal(null);
}

function applyCancelledNoteState(
  context: ActionContext,
  state: NoteState,
  conversationId: string,
  branchId: string,
) {
  if (
    context.activeRoute.current.conversationId !== conversationId ||
    context.activeRoute.current.branchId !== branchId
  )
    return;
  const current =
    context.queryClient.getQueryData<Conversation>(['conversation', conversationId, branchId]) ??
    (context.conversation?.id === conversationId ? context.conversation : null);
  if (current && current.noteId !== state.note.id) {
    cacheConversationUpdate(
      context.queryClient,
      { ...current, noteId: state.note.id },
      context.activeConversationId,
      context.activeBranchId,
      current.branchId,
    );
    context.queryClient.setQueryData<ConversationSummary[]>(['conversations'], (items = []) =>
      items.map((item) => (item.id === conversationId ? { ...item, noteId: state.note.id } : item)),
    );
  }
  applyNoteState(context, state);
}

function useConversationStateActions(context: ActionContext) {
  return {
    ensureConversation: () => ensureConversation(context),
    applyNoteState: (state: NoteState, authoritative = false) =>
      applyNoteState(context, state, authoritative),
    applyCancelledNoteState: (state: NoteState, conversationId: string, branchId: string) =>
      applyCancelledNoteState(context, state, conversationId, branchId),
  };
}

function useNotePanelActions(context: ActionContext) {
  const showNote = () => {
    track('note_opened', { conversation_id: context.conversation?.id });
    context.dismissedNoteConversations.delete(context.noteConversationKey);
    writeDismissedNotePanels(context.identity, context.dismissedNoteConversations);
    context.setNoteOpen(true);
    context.setMobilePane('note');
  };
  const startChatFromNote = () => {
    if (context.activeNoteId) {
      void api
        .startConversation(context.activeNoteId)
        .then(context.setConversation)
        .catch((error) =>
          context.setNotice(
            error instanceof Error ? error.message : 'The chat could not be started.',
          ),
        );
      return;
    }
    context.setRetainedNoteChatStarted(true);
    context.setMobilePane('chat');
  };
  const renameStandaloneNote = async (value: string) => {
    if (!context.activeNoteId) return;
    const title = value.trim() || 'Untitled note';
    if (title === context.draftRef.current?.title) return;
    try {
      const renamed = await api.renameNote(context.activeNoteId, title);
      if (context.draftRef.current?.id === context.activeNoteId) {
        const next = { ...context.draftRef.current, title: renamed.title };
        context.draftRef.current = next;
        context.setDraft(next);
      }
      context.queryClient.setQueryData<Note[]>(['notes'], (notes = []) =>
        notes.map((note) =>
          note.id === context.activeNoteId ? { ...note, title: renamed.title } : note,
        ),
      );
    } catch (error) {
      context.setNotice(error instanceof Error ? error.message : 'The note could not be renamed.');
    }
  };
  const closeNote = () => {
    track('note_closed', { conversation_id: context.conversation?.id });
    context.dismissedNoteConversations.add(context.noteConversationKey);
    writeDismissedNotePanels(context.identity, context.dismissedNoteConversations);
    context.setNoteOpen(false);
    context.setMobilePane('chat');
  };
  const exportNote = () => {
    const markdown = context.draftRef.current?.markdown ?? context.unsavedDraftRef.current.markdown;
    try {
      const blob = new Blob([markdown], { type: 'text/markdown; charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${context.conversation?.title || 'note'}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      context.setNotice(error instanceof Error ? error.message : 'The note could not be exported.');
    }
  };
  return { showNote, startChatFromNote, renameStandaloneNote, closeNote, exportNote };
}

export function useConversationActions(context: ActionContext, flush: Flush) {
  const rename = useConversationRename(context);
  const deletion = useConversationDeletion(context, flush);
  const state = useConversationStateActions(context);
  const panel = useNotePanelActions(context);
  return { ...rename, ...deletion, ...state, ...panel };
}
