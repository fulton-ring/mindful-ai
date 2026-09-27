import type { EditProposal, Note, NoteDecision, NoteState } from '@walden/contracts';
import { additionEdit, rebaseQueueAfterAcceptance, resolveEdit } from '@walden/domain';
import {
  acceptedProposalMarkdown,
  pinAdditionQueue,
} from '../../features/notes/proposals/pending-projection';
import { proposalStillApplies } from '../../features/notes/proposals/proposal-scope';
import { api } from '../../lib/api';
import { id } from '../../lib/ids';
import { failureDetails, track } from '../../lib/telemetry';
import type { ConversationContext } from '../data/conversation-context';
import { NO_PREVIEWS, type ProposalRequest } from '../data/use-conversation-shell';
import {
  cacheConversationUpdate,
  type NoteMutationScope,
  noteMutationBelongsToRoute,
  writeCachedDraft,
} from '../lifecycle/workspace-helpers';

type ProposalContext = ConversationContext;

export type ProposalDependencies = {
  flush: () => Promise<number | null | false>;
  applyNoteState: (state: NoteState, authoritative?: boolean) => void;
};

async function prepareDecision(
  context: ProposalContext,
  dependencies: ProposalDependencies,
  value: EditProposal,
) {
  if ((await dependencies.flush()) === false) return null;
  const current = context.draftRef.current;
  return current &&
    current.id === value.noteId &&
    context.proposalsRef.current.some((item) => item.id === value.id)
    ? current
    : null;
}

async function runDecision(
  context: ProposalContext,
  dependencies: ProposalDependencies,
  value: EditProposal,
  decision: NoteDecision['decision'],
  current: Note,
  reviewedMarkdown: string | null,
) {
  const scope: NoteMutationScope = { ...context.activeRoute.current, noteId: current.id };
  const isCurrent = () =>
    noteMutationBelongsToRoute(
      scope,
      context.activeRoute.current.conversationId,
      context.activeRoute.current.branchId,
      context.draftRef.current?.id ?? null,
    );
  return api
    .decideSuggestion(
      value.noteId,
      value.id,
      decision,
      current.revision,
      id(`suggestion-${decision}`),
      reviewedMarkdown ?? undefined,
    )
    .then((state) => {
      if (!isCurrent()) {
        void context.queryClient.invalidateQueries({ queryKey: ['note-state', scope.noteId] });
        return false;
      }
      context.dismissedSuggestionIds.current.delete(value.id);
      if (context.proposalRef.current?.id === value.id) {
        context.proposalRef.current = null;
        context.setProposal(null);
      }
      if (decision === 'accept')
        context.queueOrderRef.current = rebaseQueueAfterAcceptance(
          current.markdown,
          state.note.markdown,
          context.queueOrderRef.current,
          value.id,
        );
      dependencies.applyNoteState(state, true);
      return true;
    })
    .catch((error) => {
      if (context.deletedNoteIds.current.has(value.noteId) || !isCurrent()) return false;
      track('note_suggestion_failed', {
        conversation_id: context.conversation?.id,
        action: decision,
        ...failureDetails(error),
      });
      context.setNotice(
        error instanceof Error ? error.message : 'The suggestion could not be updated.',
      );
      context.dismissedSuggestionIds.current.delete(value.id);
      context.setProposals((items) =>
        items.some((item) => item.id === value.id) ? items : [value, ...items],
      );
      if (context.proposalRef.current?.id === value.id) context.setProposal(value);
      return false;
    });
}

async function decideSuggestion(
  context: ProposalContext,
  dependencies: ProposalDependencies,
  value: EditProposal,
  decision: NoteDecision['decision'],
) {
  if (context.suggestionDecisionPromise.current) return context.suggestionDecisionPromise.current;
  if (context.suggestionDecisionPreparing.current) return false;
  context.suggestionDecisionPreparing.current = true;
  context.setDecisionPending(true);
  const current = await prepareDecision(context, dependencies, value);
  if (!current) {
    track('action_blocked', { action: `suggestion_${decision}`, failure_code: 'note_not_ready' });
    return resetDecision(context);
  }
  if (decision === 'accept' && !value.oldText)
    context.queueOrderRef.current = pinAdditionQueue(
      current.markdown,
      context.proposalsRef.current,
      context.queueOrderRef.current,
    );
  const reviewedMarkdown =
    decision === 'accept'
      ? acceptedProposalMarkdown(
          current.markdown,
          value,
          context.proposalsRef.current,
          context.queueOrderRef.current,
        )
      : null;
  if (decision === 'accept' && reviewedMarkdown === null) {
    track('action_blocked', { action: 'suggestion_accept', failure_code: 'proposal_conflict' });
    context.setNotice('This suggestion no longer matches the note. Refresh and review it again.');
    return resetDecision(context);
  }
  if (decision === 'reject') {
    context.dismissedSuggestionIds.current.add(value.id);
    context.setProposals((items) => items.filter((item) => item.id !== value.id));
    if (context.proposalRef.current?.id === value.id) context.setProposal(null);
  }
  const running = runDecision(
    context,
    dependencies,
    value,
    decision,
    current,
    reviewedMarkdown,
  ).finally(() => {
    if (context.suggestionDecisionPromise.current === running)
      context.suggestionDecisionPromise.current = null;
    context.setDecisionPending(false);
  });
  context.suggestionDecisionPromise.current = running;
  context.suggestionDecisionPreparing.current = false;
  return running;
}

function resetDecision(context: ProposalContext) {
  context.suggestionDecisionPreparing.current = false;
  context.setDecisionPending(false);
  return false;
}

function resolveProposals(current: Note | null, request: ProposalRequest, values: EditProposal[]) {
  if (!proposalStillApplies(request, current)) return [];
  return values.filter((value) => {
    try {
      resolveEdit(current?.markdown ?? '', value.oldText, value.newText);
      return true;
    } catch {
      return false;
    }
  });
}

function rememberAdditionPlacement(context: ProposalContext, value: EditProposal) {
  const placementText = context.proposalRequestRef.current?.capturedText ?? value.newText;
  if (value.oldText || !placementText.trim()) return;
  const queue = context.queueOrderRef.current;
  if (queue.some((item) => item.id === value.id && item.at !== undefined)) return;
  const markdown = context.draftRef.current?.markdown ?? context.unsavedDraftRef.current.markdown;
  const at = additionEdit(markdown, placementText).from;
  const existing = queue.findIndex((item) => item.id === value.id);
  const placed = { id: value.id, text: value.newText, accepted: false, at };
  context.queueOrderRef.current =
    existing < 0
      ? [...queue, placed]
      : queue.map((item, index) => (index === existing ? placed : item));
}

async function loadCompletedProposals(
  context: ProposalContext,
  dependencies: ProposalDependencies,
  loading: ProposalRequest,
  active: EditProposal,
) {
  const [state, refreshedConversation] = await Promise.all([
    context.queryClient.fetchQuery({
      queryKey: ['note-state', active.noteId],
      queryFn: () => api.noteState(active.noteId),
      staleTime: 0,
    }),
    context.activeConversationId && context.conversation?.noteId !== active.noteId
      ? api.conversation(context.activeConversationId, context.activeBranchId)
      : Promise.resolve(null),
  ]);
  if (
    context.proposalRequestRef.current !== loading ||
    context.deletedNoteIds.current.has(active.noteId)
  )
    return;
  if (refreshedConversation)
    cacheConversationUpdate(
      context.queryClient,
      refreshedConversation,
      context.activeConversationId,
      context.activeBranchId,
      context.conversation?.branchId ?? null,
    );
  dependencies.applyNoteState(state);
  if (!context.dismissedNoteConversations.has(context.noteConversationKey)) {
    context.setNoteOpen(true);
    context.setMobilePane('note');
  }
}

function completeProposals(
  context: ProposalContext,
  dependencies: ProposalDependencies,
  values: EditProposal[],
  sourceId: string,
) {
  const request = context.proposalRequestRef.current;
  if (request?.sourceId !== sourceId || request.phase !== 'streaming') return;
  const resolved = resolveProposals(context.draftRef.current, request, values);
  const active = resolved.at(-1) ?? null;
  if (active) rememberAdditionPlacement(context, active);
  context.setProposal(active);
  context.setProposals((items) => [
    ...resolved,
    ...items.filter(
      (item) => !request.previewIds.has(item.id) && !resolved.some((value) => value.id === item.id),
    ),
  ]);
  if (!active) return void context.setProposalRequest(null);
  const loading: ProposalRequest = { ...request, phase: 'loading', previewIds: NO_PREVIEWS };
  context.setProposalRequest(loading);
  void loadCompletedProposals(context, dependencies, loading, active)
    .catch((error) => {
      if (context.proposalRequestRef.current === loading)
        context.setNotice(
          error instanceof Error ? error.message : 'The saved suggestions could not be loaded.',
        );
    })
    .finally(() => {
      if (context.proposalRequestRef.current === loading) context.setProposalRequest(null);
    });
}

export type SuggestionDismissReason = 'typing' | 'reject';

/**
 * The reader dismissed a suggestion in the editor. A still-streaming preview cancels the whole
 * request; typing over a suggestion hides it locally and records the dismissal with the next
 * save; an explicit dismissal rejects it on the server.
 */
function dismissSuggestion(
  context: ProposalContext,
  dependencies: ProposalDependencies,
  cancelProposalRequest: () => void,
  reason: SuggestionDismissReason | undefined,
  candidate: EditProposal | undefined,
) {
  const target = candidate ?? context.proposalRef.current;
  if (!target) return;
  const isActive = context.proposalRef.current?.id === target.id;
  if (context.proposalRequestRef.current?.previewIds.has(target.id)) {
    cancelProposalRequest();
    return;
  }
  track('note_suggestion_rejected', { conversation_id: context.conversation?.id });
  if (reason === 'typing') {
    context.dismissedSuggestionIds.current.add(target.id);
    context.setProposals((items) => items.filter((item) => item.id !== target.id));
    if (isActive) context.setProposal(null);
    context.dismissSuggestionsOnSave.current.add(target.id);
    const current = context.draftRef.current;
    if (current) writeCachedDraft(current, context.dismissSuggestionsOnSave.current);
    return;
  }
  void decideSuggestion(context, dependencies, target, 'reject').then((updated) => {
    if (updated && isActive) context.setProposal(null);
  });
}

function startProposalRequest(context: ProposalContext, sourceId: string, capturedText?: string) {
  context.setProposal(null);
  context.setProposalRequest({
    sourceId,
    noteId: context.draftRef.current?.id ?? 'unsaved-note',
    ...(capturedText ? { capturedText } : {}),
    phase: 'streaming',
    previewIds: NO_PREVIEWS,
  });
}

export function useProposalActions(context: ProposalContext) {
  const acceptProposal = async (value: EditProposal, dependencies: ProposalDependencies) => {
    const request = context.proposalRequestRef.current;
    if (request?.phase === 'loading' || request?.previewIds.has(value.id)) return;
    if (await decideSuggestion(context, dependencies, value, 'accept'))
      track('note_suggestion_accepted', { conversation_id: context.conversation?.id });
  };
  const cancelProposalRequest = () => {
    const request = context.proposalRequestRef.current;
    if (!request) return;
    context.setProposalRequest(null);
    context.setProposals((items) => items.filter((item) => !request.previewIds.has(item.id)));
    context.setProposal(null);
    void context.cancelProposal.current?.();
  };
  const previewProposal = (
    value: EditProposal | null,
    streaming: boolean,
    sourceId: string,
    dependencies: ProposalDependencies,
  ) => {
    if (!streaming) return completeProposals(context, dependencies, value ? [value] : [], sourceId);
    const request = context.proposalRequestRef.current;
    if (
      !value ||
      request?.sourceId !== sourceId ||
      request.phase !== 'streaming' ||
      !proposalStillApplies(request, context.draftRef.current)
    )
      return;
    rememberAdditionPlacement(context, value);
    context.setProposalRequest({
      ...request,
      previewIds: new Set([...request.previewIds, value.id]),
    });
    context.setProposal(value);
    context.setProposals((items) => [value, ...items.filter((item) => item.id !== value.id)]);
    if (!context.dismissedNoteConversations.has(context.noteConversationKey)) {
      context.setNoteOpen(true);
      context.setMobilePane('note');
    }
  };
  return {
    acceptProposal,
    cancelProposalRequest,
    previewProposal,
    startProposalRequest: (sourceId: string, capturedText?: string) =>
      startProposalRequest(context, sourceId, capturedText),
    setProposalCanceler: (cancel: (() => Promise<NoteState | null>) | null) => {
      context.cancelProposal.current = cancel;
    },
    dismissSuggestion: (
      reason: SuggestionDismissReason | undefined,
      candidate: EditProposal | undefined,
      dependencies: ProposalDependencies,
    ) => dismissSuggestion(context, dependencies, cancelProposalRequest, reason, candidate),
    completeProposals: (
      values: EditProposal[],
      sourceId: string,
      dependencies: ProposalDependencies,
    ) => completeProposals(context, dependencies, values, sourceId),
    decideSuggestion: (
      value: EditProposal,
      decision: NoteDecision['decision'],
      dependencies: ProposalDependencies,
    ) => decideSuggestion(context, dependencies, value, decision),
  };
}
