import type { WaldenDataParts, WaldenUIMessage } from '@walden/contracts';
import type { ChatOnFinishCallback, DataUIPart } from 'ai';

import { ApiError } from '../../../../../lib/api';
import { failureDetails, track } from '../../../../../lib/telemetry';
import { isInterrupted } from '../../../message-parts';
import type { LiveTurn } from '../state/use-chat-runtime-state';
import { type TurnArgs, withMetadata } from './turn-args';

type FinishEvent = Parameters<ChatOnFinishCallback<WaldenUIMessage>>[0];

/** Puts back what was sent when the server never admitted the turn. */
export function restoreDraft(args: TurnArgs, live: LiveTurn) {
  args.chat.setMessages(live.snapshot);
  if (!live.draft) return;
  args.display.setInput(live.draft.text);
  args.display.setAttachments(live.draft.files);
  args.uploads.restore(live.draft.files, live.draft.uploaded);
}

function lastUserIndex(messages: WaldenUIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]!.role === 'user') return index;
  return -1;
}

/** The optimistic user message takes the id the server stored it under. */
export function adoptUserMessageId(args: TurnArgs, userMessageId: string) {
  args.chat.setMessages((messages) => {
    const index = lastUserIndex(messages);
    if (index < 0 || messages.some(({ id }) => id === userMessageId)) return messages;
    const next = [...messages];
    next[index] = { ...next[index]!, id: userMessageId };
    return next;
  });
}

function handleTurnData(args: TurnArgs, data: WaldenDataParts['turn']) {
  const live = args.runtime.live.current;
  if (!live) return;
  live.conversationId = data.conversationId;
  live.branchId = data.branchId;
  live.title = data.title ?? live.title;
  live.expiresAt = data.expiresAt ?? live.expiresAt;
  live.failureCode = data.failureCode ?? live.failureCode;
  if (data.userMessageId && live.kind === 'send') adoptUserMessageId(args, data.userMessageId);
}

export function handleData(args: TurnArgs, part: DataUIPart<WaldenDataParts>) {
  if (part.type === 'data-status') args.display.setStatus(part.data.text);
  else if (part.type === 'data-turn') handleTurnData(args, part.data);
}

/** The transcript with this turn's reply marked interrupted (or a placeholder when none came). */
function interruptedTranscript(messages: WaldenUIMessage[], turnId: string) {
  const last = messages.at(-1);
  if (last?.role === 'assistant' && last.id === turnId)
    return [...messages.slice(0, -1), withMetadata(last, { status: 'interrupted' })];
  const placeholder: WaldenUIMessage = { id: turnId, role: 'assistant', parts: [] };
  return [...messages, withMetadata(placeholder, { status: 'interrupted' })];
}

function persistTurn(args: TurnArgs, live: LiveTurn, messages: WaldenUIMessage[]) {
  const base = args.runtime.latestConversation.current;
  if (!base || base.id !== live.conversationId) return Promise.resolve(false);
  const next = {
    ...base,
    branchId: live.branchId ?? base.branchId,
    title: live.title ?? base.title,
    expiresAt: live.expiresAt ?? base.expiresAt,
    messages,
  };
  if (next.branchId !== base.branchId) args.runtime.adoptedBranchId.current = next.branchId;
  args.runtime.latestConversation.current = next;
  return Promise.resolve(args.props.onConversation(next)).then(() => true);
}

function launchFollowups(args: TurnArgs, live: LiveTurn, message: WaldenUIMessage) {
  if (args.runtime.activeConversationId.current !== live.conversationId) return;
  const annotations = message.metadata?.annotations ?? [];
  if (annotations.length) args.followups.animateAnnotations(message.id, annotations);
  args.followups.launchFollowups(
    message.id,
    live.conversationId!,
    live.noteRevision,
    annotations.length > 0,
  );
}

function trackFinish(live: LiveTurn, failed: boolean, message: WaldenUIMessage) {
  const regenerate = live.kind === 'regenerate';
  track(
    failed
      ? regenerate
        ? 'chat_regeneration_failed'
        : 'chat_failed'
      : regenerate
        ? 'chat_regeneration_completed'
        : 'chat_completed',
    {
      conversation_id: live.conversationId,
      request_id: live.requestId,
      duration_ms: Math.round(performance.now() - live.startedAt),
      tool_count: message.parts.filter((part) => part.type.startsWith('tool-')).length,
      source_count: message.parts.filter((part) => part.type === 'source-url').length,
      ...(failed ? { failure_code: live.failureCode ?? 'interrupted', stage: 'stream' } : {}),
    },
  );
}

export function handleFinish(args: TurnArgs, event: FinishEvent) {
  const { runtime } = args;
  const reason = runtime.abortReason.current;
  runtime.abortReason.current = null;
  if (event.isAbort && reason !== 'stop') return;
  const live = runtime.live.current;
  runtime.live.current = null;
  args.display.setStatus('');
  if (!live || !runtime.mounted.current) return;
  if (!live.turnId) {
    if (event.isAbort) restoreDraft(args, live);
    return;
  }
  const failed = event.isAbort || event.isError || isInterrupted(event.message);
  trackFinish(live, failed, event.message);
  if (failed && live.kind === 'regenerate') {
    args.chat.setMessages(live.snapshot);
    return;
  }
  const messages = failed ? interruptedTranscript(event.messages, live.turnId) : event.messages;
  if (failed) args.chat.setMessages(messages);
  void persistTurn(args, live, messages).then((persisted) => {
    if (persisted && !failed) launchFollowups(args, live, event.message);
  });
}

/** The server's 429 body is `{ error, details: { code: 'message_limit', retryAt } }`. */
const isMessageLimit = (error: Error) =>
  error instanceof ApiError &&
  (error.details as { details?: { code?: string } } | undefined)?.details?.code === 'message_limit';

export function handleError(args: TurnArgs, error: Error) {
  const live = args.runtime.live.current;
  if (!live) return;
  // Nothing was admitted (message limit, conflict, failed preflight): keep the draft.
  if (!live.turnId) {
    restoreDraft(args, live);
    args.props.onBudget?.();
  }
  track('chat_failed', {
    conversation_id: live.conversationId,
    request_id: live.requestId,
    stage: live.turnId ? 'generation' : 'start',
    ...(live.failureCode ? { failure_code: live.failureCode } : failureDetails(error)),
  });
  // A turn stopped elsewhere (another tab) ends as interrupted without an error banner,
  // and the composer itself explains a message limit.
  if (live.failureCode !== 'cancelled' && !isMessageLimit(error))
    args.display.setError(error.message || 'The response was interrupted.');
}
