import type { EditProposal, NoteProposalEvent, NoteState } from '@walden/contracts';

import { api, type MessageFollowupRequest, streamNoteProposal } from '../../../lib/api';
import { id } from '../../../lib/ids';
import type { ChatPanelProps } from './chat-panel-types';
import type { ChatDisplayState, ProposalNotice } from './use-chat-display-state';
import type { ChatRuntimeState } from './use-chat-runtime-state';

type ProposalArgs = {
  props: ChatPanelProps;
  display: ChatDisplayState;
  runtime: ChatRuntimeState;
  effectivePersonaId: string;
};

type ProposalRun = {
  controller: AbortController;
  messageId: string;
  conversationId: string;
  sourceId: string;
  branchId: string | null;
  input: MessageFollowupRequest;
  retryCapture?: { text: string };
  observedAttemptId: string | null;
  cancelling: Promise<NoteState | null> | null;
  cancelled: boolean;
  settled: boolean;
  previews: Map<string, EditProposal>;
};

function setProposalNotice(display: ChatDisplayState, messageId: string, notice: ProposalNotice) {
  display.setProposalNotices((current) => new Map(current).set(messageId, notice));
}

function clearProposalNotice(display: ChatDisplayState, messageId: string) {
  display.setProposalNotices((current) => {
    if (!current.has(messageId)) return current;
    const next = new Map(current);
    next.delete(messageId);
    return next;
  });
}

function proposalIsCurrent(args: ProposalArgs, run: ProposalRun) {
  return (
    !run.controller.signal.aborted &&
    args.runtime.activeConversationId.current === run.conversationId
  );
}

function retryCapture(input: MessageFollowupRequest) {
  return input.action === 'capture' && input.captureText ? { text: input.captureText } : undefined;
}

function cancelProposal(args: ProposalArgs, run: ProposalRun): Promise<NoteState | null> {
  if (run.cancelling) return run.cancelling;
  if (!run.cancelled) {
    if (args.runtime.proposalAbort.current !== run.controller) return Promise.resolve(null);
    run.cancelled = true;
    run.controller.abort();
    args.runtime.proposalAbort.current = undefined;
    args.props.onProposalCancelable(null);
    args.display.setProposalMessageId((current) => (current === run.messageId ? null : current));
    args.props.onGhost(null, false, run.sourceId);
  }
  if (!run.observedAttemptId || !run.branchId) return Promise.resolve(null);
  run.cancelling = api
    .cancelNoteProposal(run.messageId, {
      conversationId: run.conversationId,
      branchId: run.branchId,
      attemptId: run.observedAttemptId,
    })
    .then((result) => finishProposalCancellation(args, run, result.noteState))
    .catch(() => failProposalCancellation(args, run))
    .finally(() => {
      run.cancelling = null;
    });
  return run.cancelling;
}

async function finishProposalCancellation(
  args: ProposalArgs,
  run: ProposalRun,
  state: NoteState | null,
) {
  if (proposalScopeIsCurrent(args, run)) clearProposalNotice(args.display, run.messageId);
  if (state && proposalScopeIsCurrent(args, run))
    await args.props.onProposalCancelled?.(state, run.conversationId, run.branchId!);
  return state;
}

function proposalScopeIsCurrent(args: ProposalArgs, run: ProposalRun) {
  return (
    args.runtime.activeConversationId.current === run.conversationId &&
    args.runtime.activeBranchId.current === run.branchId
  );
}

function failProposalCancellation(args: ProposalArgs, run: ProposalRun) {
  if (proposalScopeIsCurrent(args, run))
    setProposalNotice(args.display, run.messageId, {
      message: 'The note suggestion could not be cancelled. Please try again.',
      retryable: true,
      onRetry: () => void cancelProposal(args, run),
    });
  return null;
}

function handleProposalDone(
  args: ProposalArgs,
  run: ProposalRun,
  event: Extract<NoteProposalEvent, { type: 'done' }>,
) {
  run.settled = true;
  if (event.proposals && args.props.onGhostBatch)
    args.props.onGhostBatch(event.proposals, run.sourceId);
  else args.props.onGhost(event.proposal, false, run.sourceId);
  if (run.sourceId.startsWith('proposal-manual') && !event.proposal && event.reason)
    setProposalNotice(args.display, run.messageId, {
      message: event.reason,
      retryable: false,
      ...(run.retryCapture ? { capture: run.retryCapture } : {}),
    });
}

function handleProposalErrorEvent(args: ProposalArgs, run: ProposalRun, message: string) {
  run.settled = true;
  args.props.onGhost(null, false, run.sourceId);
  setProposalNotice(args.display, run.messageId, {
    message,
    retryable: true,
    ...(run.retryCapture ? { capture: run.retryCapture } : {}),
  });
}

function handleProposalEvent(args: ProposalArgs, run: ProposalRun, event: NoteProposalEvent) {
  if (!proposalIsCurrent(args, run)) return;
  if (event.type === 'preview') {
    run.observedAttemptId ??= event.proposal.id.replace(/:\d+$/, '');
    run.previews.set(event.proposal.id, event.proposal);
    args.props.onGhost(event.proposal, true, run.sourceId);
  } else if (event.type === 'done') handleProposalDone(args, run, event);
  else handleProposalErrorEvent(args, run, event.message);
}

function finishProposalStream(args: ProposalArgs, run: ProposalRun) {
  if (args.runtime.proposalAbort.current === run.controller) {
    args.runtime.proposalAbort.current = undefined;
    args.props.onProposalCancelable(null);
  }
  args.display.setProposalMessageId((current) => (current === run.messageId ? null : current));
  if (run.settled || run.controller.signal.aborted || !proposalIsCurrent(args, run)) return;
  const arrived = [...run.previews.values()];
  if (arrived.length && args.props.onGhostBatch) args.props.onGhostBatch(arrived, run.sourceId);
  else args.props.onGhost(arrived.at(-1) ?? null, false, run.sourceId);
}

function launchNoteProposal(
  args: ProposalArgs,
  messageId: string,
  conversationId: string,
  input: MessageFollowupRequest,
  sourceId: string,
) {
  args.runtime.proposalAbort.current?.abort();
  const run: ProposalRun = {
    controller: new AbortController(),
    messageId,
    conversationId,
    sourceId,
    branchId:
      args.runtime.activeBranchId.current ??
      args.runtime.latestConversation.current?.branchId ??
      null,
    input,
    retryCapture: retryCapture(input),
    observedAttemptId: null,
    cancelling: null,
    cancelled: false,
    settled: false,
    previews: new Map(),
  };
  args.runtime.proposalAbort.current = run.controller;
  args.display.setProposalMessageId(messageId);
  clearProposalNotice(args.display, messageId);
  args.props.onProposalCancelable(() => cancelProposal(args, run));
  args.props.onProposalStart(sourceId);
  void runProposalStream(run, args)
    .catch((error) => handleProposalTransportError(args, run, error))
    .finally(() => finishProposalStream(args, run));
}

async function runProposalStream(run: ProposalRun, args: ProposalArgs) {
  await streamNoteProposal(
    run.messageId,
    run.input,
    (event) => handleProposalEvent(args, run, event),
    run.controller.signal,
  );
}

function handleProposalTransportError(args: ProposalArgs, run: ProposalRun, error: unknown) {
  run.settled = true;
  if (
    run.controller.signal.aborted ||
    args.runtime.activeConversationId.current !== run.conversationId
  )
    return;
  handleProposalErrorEvent(
    args,
    run,
    error instanceof Error
      ? error.message
      : 'The note suggestion was interrupted. Please try again.',
  );
}

async function prepareProposal(args: ProposalArgs, messageId: string, capture?: { text: string }) {
  const conversationId = args.runtime.activeConversationId.current;
  if (
    !conversationId ||
    args.runtime.proposalAbort.current ||
    args.runtime.proposalPreparing.current
  )
    return;
  args.props.onOpenNote();
  args.runtime.proposalPreparing.current = true;
  const preparation = ++args.runtime.proposalPreparationGeneration.current;
  const lifecycle = args.runtime.lifecycleCancellation.current;
  clearProposalNotice(args.display, messageId);
  const noteRevision = await args.props.onFlush();
  if (args.runtime.proposalPreparationGeneration.current === preparation)
    args.runtime.proposalPreparing.current = false;
  if (!proposalPreparationIsValid(args, conversationId, preparation, lifecycle, noteRevision)) {
    if (noteRevision === false) reportBlockedProposal(args, messageId, capture);
    return;
  }
  if (noteRevision === false) return;
  launchNoteProposal(
    args,
    messageId,
    conversationId,
    {
      conversationId,
      branchId: args.runtime.latestConversation.current?.branchId ?? '',
      personaId: args.effectivePersonaId,
      noteRevision,
      noteProposalRequested: true,
      ...(capture ? { action: 'capture' as const, captureText: capture.text } : {}),
    },
    id('proposal-manual'),
  );
}

function proposalPreparationIsValid(
  args: ProposalArgs,
  conversationId: string,
  preparation: number,
  lifecycle: number,
  noteRevision: number | null | false,
) {
  return (
    noteRevision !== false &&
    args.runtime.proposalPreparationGeneration.current === preparation &&
    args.runtime.lifecycleCancellation.current === lifecycle &&
    args.runtime.activeConversationId.current === conversationId
  );
}

function reportBlockedProposal(args: ProposalArgs, messageId: string, capture?: { text: string }) {
  setProposalNotice(args.display, messageId, {
    message: 'Your note still has unsaved changes. Resolve the save, then try again.',
    retryable: true,
    ...(capture ? { capture } : {}),
  });
}

export function useChatProposals(args: ProposalArgs) {
  return {
    launchNoteProposal: (
      messageId: string,
      conversationId: string,
      input: MessageFollowupRequest,
      sourceId: string,
    ) => launchNoteProposal(args, messageId, conversationId, input, sourceId),
    proposeNote: (messageId: string, capture?: { text: string }) =>
      prepareProposal(args, messageId, capture),
    dismissProposalNotice: (messageId: string) => clearProposalNotice(args.display, messageId),
  };
}
