import type { useConversationComposition } from '../data/use-conversation-composition';
import { type CaptureDependencies, useCaptureActions } from './use-capture-actions';
import { useConversationActions } from './use-conversation-actions';
import { type DraftDependencies, useDraftActions, useDraftBlocker } from './use-draft-actions';
import { useNoteConflict } from './use-note-conflict';
import { type HistoryDependencies, useNoteHistory } from './use-note-history';
import { type ProposalDependencies, useProposalActions } from './use-proposal-actions';

type Composition = ReturnType<typeof useConversationComposition>;

function useConversationActionPrimitives(composition: Composition) {
  const { baseContext, navigation, editor, doSave } = composition;
  const captureActions = useCaptureActions({
    ...baseContext,
    setConversation: navigation.setConversation,
    captureError: (message) => editor.setNotice(message),
  });

  function ensureConversation() {
    return conversationActions.ensureConversation();
  }

  function captureText(text: string, verbatim: boolean) {
    const dependencies: CaptureDependencies = {
      ensureConversation,
      updateDraft: draftActions.updateDraft,
      flushNoteDraft,
    };
    return captureActions.captureText(dependencies, text, verbatim);
  }

  function cancelProposalRequest() {
    return proposalActions.cancelProposalRequest();
  }

  function getDraftDependencies(): DraftDependencies {
    return { captureText, cancelProposalRequest };
  }

  const draftActions = useDraftActions({ ...baseContext, doSave });

  function flush(allowConflict = false) {
    return draftActions.flush(allowConflict, getDraftDependencies());
  }

  function flushNoteDraft() {
    return draftActions.flushNoteDraft(getDraftDependencies());
  }

  const conversationActions = useConversationActions({ ...baseContext }, flush);
  const proposalActions = useProposalActions({ ...baseContext });
  const proposalDependencies: ProposalDependencies = {
    flush,
    applyNoteState: conversationActions.applyNoteState,
  };
  const conflictActions = useNoteConflict({ ...baseContext, doSave });
  const historyActions = useNoteHistory({ ...baseContext });
  const historyDependencies: HistoryDependencies = {
    flush,
    applyNoteState: conversationActions.applyNoteState,
  };
  useDraftBlocker({ ...baseContext, doSave }, draftActions.flush, getDraftDependencies);
  return {
    captureActions,
    conversationActions,
    draftActions,
    conflictActions,
    historyActions,
    historyDependencies,
    proposalActions,
    proposalDependencies,
    captureText,
    cancelProposalRequest,
    ensureConversation,
    flush,
    flushNoteDraft,
    getDraftDependencies,
  };
}

type ActionPrimitives = ReturnType<typeof useConversationActionPrimitives>;

function createConversationActionHandlers(primitives: ActionPrimitives) {
  const {
    captureActions,
    conversationActions,
    draftActions,
    conflictActions,
    historyActions,
    historyDependencies,
    proposalActions,
    proposalDependencies,
    captureText,
    cancelProposalRequest,
    ensureConversation,
    flush,
    flushNoteDraft,
    getDraftDependencies,
  } = primitives;
  const acceptProposal = (value: Parameters<typeof proposalActions.acceptProposal>[0]) =>
    proposalActions.acceptProposal(value, proposalDependencies);
  const decideSuggestion = (
    value: Parameters<typeof proposalActions.decideSuggestion>[0],
    decision: Parameters<typeof proposalActions.decideSuggestion>[1],
  ) => proposalActions.decideSuggestion(value, decision, proposalDependencies);
  const previewProposal = (
    value: Parameters<typeof proposalActions.previewProposal>[0],
    streaming: Parameters<typeof proposalActions.previewProposal>[1],
    sourceId: Parameters<typeof proposalActions.previewProposal>[2],
  ) => proposalActions.previewProposal(value, streaming, sourceId, proposalDependencies);
  const completeProposals = (
    values: Parameters<typeof proposalActions.completeProposals>[0],
    sourceId: Parameters<typeof proposalActions.completeProposals>[1],
  ) => proposalActions.completeProposals(values, sourceId, proposalDependencies);
  const updateUnsavedDraft = (
    markdown: Parameters<typeof draftActions.updateUnsavedDraft>[0],
    provenance: Parameters<typeof draftActions.updateUnsavedDraft>[1],
  ) => draftActions.updateUnsavedDraft(markdown, provenance, getDraftDependencies());
  const persistUnsavedDraft = () => draftActions.persistUnsavedDraft(getDraftDependencies());
  const moveNoteHistory = (action: Parameters<typeof historyActions.moveNoteHistory>[0]) =>
    historyActions.moveNoteHistory(action, historyDependencies);
  return {
    ...draftActions,
    ...proposalActions,
    ...conversationActions,
    ...captureActions,
    ...conflictActions,
    ...historyActions,
    acceptProposal,
    cancelProposalRequest,
    captureText,
    completeProposals,
    decideSuggestion,
    ensureConversation,
    flush,
    flushNoteDraft,
    moveNoteHistory,
    persistUnsavedDraft,
    previewProposal,
    updateUnsavedDraft,
  };
}

export function useConversationActionGroups(composition: Composition) {
  return createConversationActionHandlers(useConversationActionPrimitives(composition));
}
