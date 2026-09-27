import type { ProvenanceSpan } from '@walden/contracts';
import { conversationContext } from '../data/conversation-context';
import type { useConversationComposition } from '../data/use-conversation-composition';
import { type CaptureDependencies, useCaptureActions } from './use-capture-actions';
import { useConversationActions } from './use-conversation-actions';
import { type DraftDependencies, useDraftActions, useDraftBlocker } from './use-draft-actions';
import { useNoteConflict } from './use-note-conflict';
import { useNoteHistory } from './use-note-history';
import { type ProposalDependencies, useProposalActions } from './use-proposal-actions';

type Composition = ReturnType<typeof useConversationComposition>;

/**
 * Wires the workspace action hooks together. The hooks depend on one another only through the
 * small dependency objects built here, so every returned action is listed explicitly.
 */
export function useConversationActionGroups(composition: Composition) {
  const { doSave } = composition;
  const context = conversationContext(composition);
  const captureActions = useCaptureActions({ ...context, captureError: context.setNotice });
  const draftActions = useDraftActions({ ...context, doSave });
  const proposalActions = useProposalActions(context);
  const getDraftDependencies = (): DraftDependencies => ({
    captureText,
    cancelProposalRequest: proposalActions.cancelProposalRequest,
  });
  const flush = (allowConflict = false) =>
    draftActions.flush(allowConflict, getDraftDependencies());
  const conversationActions = useConversationActions(context, flush);
  const proposalDependencies: ProposalDependencies = {
    flush,
    applyNoteState: conversationActions.applyNoteState,
  };
  const conflictActions = useNoteConflict({ ...context, doSave });
  const historyActions = useNoteHistory(context);
  useDraftBlocker({ ...context, doSave }, draftActions.flush, getDraftDependencies);

  function captureText(text: string, verbatim: boolean) {
    const dependencies: CaptureDependencies = {
      ensureConversation: () => conversationActions.ensureConversation(),
      updateDraft: draftActions.updateDraft,
      flushNoteDraft: () => draftActions.flushNoteDraft(getDraftDependencies()),
    };
    return captureActions.captureText(dependencies, text, verbatim);
  }

  return {
    mutations: {
      deleteConversation: conversationActions.deleteConversation,
      deleteNote: conversationActions.deleteNote,
    },
    callbacks: {
      flush,
      changeNote: (markdown: string, provenance: ProvenanceSpan[]) =>
        context.draftRef.current
          ? draftActions.updateDraft(markdown, provenance)
          : draftActions.updateUnsavedDraft(markdown, provenance, getDraftDependencies()),
      retrySave: () =>
        context.draftRef.current
          ? doSave()
          : draftActions.persistUnsavedDraft(getDraftDependencies()),
      keepLocalDraft: conflictActions.keepLocalDraft,
      loadLatestNote: conflictActions.loadLatestNote,
      moveNoteHistory: (action: 'undo' | 'redo') =>
        historyActions.moveNoteHistory(action, proposalDependencies),
      ...proposalCallbacks(proposalActions, proposalDependencies),
      ensureConversation: conversationActions.ensureConversation,
      applyCancelledNoteState: conversationActions.applyCancelledNoteState,
      refreshConversationNote: conversationActions.refreshConversationNote,
      renameConversation: conversationActions.renameConversation,
      renameStandaloneNote: conversationActions.renameStandaloneNote,
      showNote: conversationActions.showNote,
      closeNote: conversationActions.closeNote,
      startChatFromNote: conversationActions.startChatFromNote,
      exportNote: conversationActions.exportNote,
    },
  };
}

type ProposalActions = ReturnType<typeof useProposalActions>;

function proposalCallbacks(actions: ProposalActions, dependencies: ProposalDependencies) {
  return {
    startProposalRequest: actions.startProposalRequest,
    setProposalCanceler: actions.setProposalCanceler,
    acceptProposal: (value: Parameters<ProposalActions['acceptProposal']>[0]) =>
      actions.acceptProposal(value, dependencies),
    dismissSuggestion: (
      reason: Parameters<ProposalActions['dismissSuggestion']>[0],
      candidate: Parameters<ProposalActions['dismissSuggestion']>[1],
    ) => actions.dismissSuggestion(reason, candidate, dependencies),
    previewProposal: (
      value: Parameters<ProposalActions['previewProposal']>[0],
      streaming: Parameters<ProposalActions['previewProposal']>[1],
      sourceId: Parameters<ProposalActions['previewProposal']>[2],
    ) => actions.previewProposal(value, streaming, sourceId, dependencies),
    completeProposals: (
      values: Parameters<ProposalActions['completeProposals']>[0],
      sourceId: Parameters<ProposalActions['completeProposals']>[1],
    ) => actions.completeProposals(values, sourceId, dependencies),
  };
}
