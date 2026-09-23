import type { useConversationComposition } from '../data/use-conversation-composition';
import { type CaptureDependencies, useCaptureActions } from './use-capture-actions';
import { useConversationActions } from './use-conversation-actions';
import { type DraftDependencies, useDraftActions, useDraftBlocker } from './use-draft-actions';
import { useNoteConflict } from './use-note-conflict';
import { useNoteHistory } from './use-note-history';
import { useProposalActions } from './use-proposal-actions';

type Composition = ReturnType<typeof useConversationComposition>;

function actionContext({
  identity,
  route,
  panel,
  themeState,
  editor,
  sidebar,
  query,
  navigation,
}: Composition) {
  return {
    identity,
    ...route,
    ...panel,
    ...themeState,
    ...editor,
    ...sidebar,
    ...query,
    ...navigation,
  };
}

export function useConversationActionGroups(composition: Composition) {
  const { editor, doSave } = composition;
  const context = actionContext(composition);
  const captureActions = useCaptureActions({
    ...context,
    captureError: editor.setNotice,
  });

  function captureText(text: string, verbatim: boolean) {
    const dependencies: CaptureDependencies = {
      ensureConversation: () => conversationActions.ensureConversation(),
      updateDraft: draftActions.updateDraft,
      flushNoteDraft: () => draftActions.flushNoteDraft(getDraftDependencies()),
    };
    return captureActions.captureText(dependencies, text, verbatim);
  }

  function getDraftDependencies(): DraftDependencies {
    return {
      captureText,
      cancelProposalRequest: proposalActions.cancelProposalRequest,
    };
  }

  const draftActions = useDraftActions({ ...context, doSave });
  const flush = (allowConflict = false) =>
    draftActions.flush(allowConflict, getDraftDependencies());
  const conversationActions = useConversationActions(context, flush);
  const proposalActions = useProposalActions(context);
  const proposalDependencies = { flush, applyNoteState: conversationActions.applyNoteState };
  const conflictActions = useNoteConflict({ ...context, doSave });
  const historyActions = useNoteHistory(context);
  useDraftBlocker({ ...context, doSave }, draftActions.flush, getDraftDependencies);

  return {
    ...draftActions,
    ...proposalActions,
    ...conversationActions,
    ...captureActions,
    ...conflictActions,
    ...historyActions,
    captureText,
    flush,
    flushNoteDraft: () => draftActions.flushNoteDraft(getDraftDependencies()),
    persistUnsavedDraft: () => draftActions.persistUnsavedDraft(getDraftDependencies()),
    updateUnsavedDraft: (
      markdown: Parameters<typeof draftActions.updateUnsavedDraft>[0],
      provenance: Parameters<typeof draftActions.updateUnsavedDraft>[1],
    ) => draftActions.updateUnsavedDraft(markdown, provenance, getDraftDependencies()),
    acceptProposal: (value: Parameters<typeof proposalActions.acceptProposal>[0]) =>
      proposalActions.acceptProposal(value, proposalDependencies),
    decideSuggestion: (
      value: Parameters<typeof proposalActions.decideSuggestion>[0],
      decision: Parameters<typeof proposalActions.decideSuggestion>[1],
    ) => proposalActions.decideSuggestion(value, decision, proposalDependencies),
    previewProposal: (
      value: Parameters<typeof proposalActions.previewProposal>[0],
      streaming: Parameters<typeof proposalActions.previewProposal>[1],
      sourceId: Parameters<typeof proposalActions.previewProposal>[2],
    ) => proposalActions.previewProposal(value, streaming, sourceId, proposalDependencies),
    completeProposals: (
      values: Parameters<typeof proposalActions.completeProposals>[0],
      sourceId: Parameters<typeof proposalActions.completeProposals>[1],
    ) => proposalActions.completeProposals(values, sourceId, proposalDependencies),
    moveNoteHistory: (action: Parameters<typeof historyActions.moveNoteHistory>[0]) =>
      historyActions.moveNoteHistory(action, proposalDependencies),
  };
}
