import type { ChatEvent, Conversation, Message } from '@walden/contracts';

import { streamChat } from '../../../../../lib/api';
import { id } from '../../../../../lib/ids';
import { failureDetails, track } from '../../../../../lib/telemetry';
import type { ChatPanelProps } from '../../chat-panel-types';
import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatRuntimeState } from '../state/use-chat-runtime-state';
import type { ChatTurnState } from '../state/use-chat-turn';
import { handleLiveChatEvent } from './live-chat-event';

type RegenerateArgs = {
  props: ChatPanelProps;
  display: ChatDisplayState;
  runtime: ChatRuntimeState;
  turn: ChatTurnState;
  effectivePersonaId: string;
  animateAnnotations(messageId: string, values: NonNullable<Message['annotations']>): void;
  launchFollowups(
    messageId: string,
    conversationId: string,
    noteRevision: number | null,
    annotationsHandled?: boolean,
  ): void;
};

type Regeneration = {
  conversation: Conversation;
  priorUser: Message;
  messageId: string;
  targetIndex: number;
  noteRevision: number | null;
  requestController: AbortController;
  requestId: string;
};

function regenerationTarget(conversation: Conversation, message: Message) {
  const targetIndex = conversation.messages.findIndex((item) => item.id === message.id);
  const priorUser = conversation.messages[targetIndex - 1];
  return priorUser?.role === 'user' ? { targetIndex, priorUser } : null;
}

function releaseRegeneration(args: RegenerateArgs, controller: AbortController, message?: string) {
  if (args.runtime.mainAbort.current === controller) args.runtime.mainAbort.current = undefined;
  args.display.setSending(false);
  if (message) args.display.setError(message);
}

async function prepareRegeneration(
  args: RegenerateArgs,
  message: Message,
): Promise<Regeneration | null> {
  const conversation = args.runtime.latestConversation.current;
  if (!conversation || args.display.sendingRef.current) return null;
  const target = regenerationTarget(conversation, message);
  if (!target) return null;
  args.display.setSending(true);
  args.runtime.proposalAbort.current?.abort();
  args.runtime.annotationControllers.current.get(message.id)?.abort();
  args.runtime.annotationControllers.current.delete(message.id);
  const preparation = ++args.runtime.preparationGeneration.current;
  const lifecycle = args.runtime.lifecycleCancellation.current;
  const controller = new AbortController();
  args.runtime.mainAbort.current = controller;
  await args.runtime.pendingTurnCancellation.current;
  const noteRevision = await args.props.onFlush();
  const valid =
    noteRevision !== false &&
    !controller.signal.aborted &&
    args.runtime.preparationGeneration.current === preparation &&
    args.runtime.lifecycleCancellation.current === lifecycle &&
    args.runtime.activeConversationId.current === conversation.id;
  if (!valid) {
    releaseRegeneration(
      args,
      controller,
      noteRevision === false
        ? 'Your note still has unsaved changes. Resolve the save before regenerating.'
        : undefined,
    );
    return null;
  }
  args.display.setRegeneratingMessageId(message.id);
  args.display.setError('');
  args.display.dispatchLiveTurn({ type: 'reset', status: 'Regenerating…' });
  args.turn.streamTarget.current = '';
  args.turn.streamCompletionId.current = null;
  args.turn.displayedStream.current = '';
  args.runtime.mainAbort.current = controller;
  const requestId = id('turn');
  args.runtime.activeRequestId.current = requestId;
  track('chat_regeneration_started', {
    conversation_id: conversation.id,
    request_id: requestId,
    persona_id: args.effectivePersonaId,
  });
  return {
    conversation,
    priorUser: target.priorUser,
    messageId: message.id,
    targetIndex: target.targetIndex,
    noteRevision,
    requestController: controller,
    requestId,
  };
}

function isCurrent(args: RegenerateArgs, run: Regeneration) {
  return (
    !run.requestController.signal.aborted &&
    args.runtime.activeRequestId.current === run.requestId &&
    args.runtime.activeConversationId.current === run.conversation.id
  );
}

function buildRegeneratedConversation(
  run: Regeneration,
  event: Extract<ChatEvent, { type: 'done' }>,
  base: Conversation,
) {
  return {
    ...base,
    branchId: event.branchId,
    title: event.title ?? base.title,
    expiresAt: event.expiresAt,
    messages: [...base.messages.slice(0, run.targetIndex), event.message],
  };
}

function drainRegeneratedResponse(
  args: RegenerateArgs,
  run: Regeneration,
  event: Extract<ChatEvent, { type: 'done' }>,
  completed: Conversation,
) {
  if (args.runtime.activeRequestId.current !== run.requestId) return;
  args.turn.streamCompletionId.current = event.message.id;
  args.turn.responseRenderKeys.current.set(event.message.id, run.requestId);
  const current = args.runtime.latestConversation.current ?? completed;
  const next = buildRegeneratedConversation(run, event, current);
  args.runtime.latestConversation.current = next;
  if (event.message.annotations?.length)
    args.animateAnnotations(event.message.id, event.message.annotations);
  void Promise.resolve(args.props.onConversation(next)).then(() => {
    if (
      args.runtime.activeConversationId.current === run.conversation.id &&
      args.runtime.activeBranchId.current === event.branchId
    )
      args.launchFollowups(
        event.message.id,
        run.conversation.id,
        run.noteRevision,
        event.annotationsHandled,
      );
  });
  args.display.setRegeneratingMessageId(null);
}

function handleRegenerationDone(
  args: RegenerateArgs,
  run: Regeneration,
  event: Extract<ChatEvent, { type: 'done' }>,
) {
  track('chat_regeneration_completed', {
    conversation_id: run.conversation.id,
    request_id: run.requestId,
    tool_count: event.message.tools?.length ?? 0,
    source_count: event.message.sources?.length ?? 0,
  });
  args.turn.streamTarget.current = event.message.content;
  const current = args.runtime.latestConversation.current ?? run.conversation;
  const completed = buildRegeneratedConversation(run, event, current);
  args.turn.onStreamDrained.current = () => drainRegeneratedResponse(args, run, event, completed);
  args.turn.displayStreamTarget(event.message.content);
}

function handleRegenerationEvent(args: RegenerateArgs, run: Regeneration, event: ChatEvent) {
  if (!isCurrent(args, run)) return;
  if (handleLiveChatEvent(args, event)) return;
  if (event.type === 'done') handleRegenerationDone(args, run, event);
  else if (event.type === 'error') {
    track('chat_regeneration_failed', {
      conversation_id: run.conversation.id,
      request_id: run.requestId,
      stage: 'generation',
      failure_code: event.code ?? 'server_error',
    });
    args.display.setError(event.message);
  }
}

function finishRegeneration(args: RegenerateArgs, run: Regeneration) {
  if (args.runtime.activeRequestId.current !== run.requestId) return;
  if (args.turn.onStreamDrained.current) args.turn.flushStream();
  args.display.setSending(false);
  if (args.turn.onStreamDrained.current)
    args.display.dispatchLiveTurn({ type: 'status', text: '' });
  else {
    args.display.setRegeneratingMessageId(null);
    args.display.dispatchLiveTurn({ type: 'reset', status: '', keepAnnotations: true });
  }
  if (args.runtime.mainAbort.current === run.requestController)
    args.runtime.mainAbort.current = undefined;
}

async function runRegeneration(args: RegenerateArgs, run: Regeneration) {
  try {
    await streamChat(
      {
        requestId: run.requestId,
        conversationId: run.conversation.id,
        branchId: run.conversation.branchId,
        noteRevision: run.noteRevision,
        message: run.priorUser.content,
        ...(run.priorUser.attachments?.length
          ? { attachmentIds: run.priorUser.attachments.map(({ id }) => id) }
          : {}),
        personaId: args.effectivePersonaId,
        action: 'message',
        regenerateMessageId: run.messageId,
      },
      (event) => handleRegenerationEvent(args, run, event),
      run.requestController.signal,
    );
  } catch (cause) {
    track('chat_regeneration_failed', {
      conversation_id: run.conversation.id,
      request_id: run.requestId,
      stage: 'stream',
      ...failureDetails(cause),
    });
    if (!run.requestController.signal.aborted)
      args.display.setError(
        cause instanceof Error ? cause.message : 'The response could not be regenerated.',
      );
  } finally {
    finishRegeneration(args, run);
  }
}

export function chatRegenerationActions(args: RegenerateArgs) {
  return {
    regenerateResponse: (message: Message) =>
      prepareRegeneration(args, message).then((run) =>
        run ? runRegeneration(args, run) : undefined,
      ),
  };
}
