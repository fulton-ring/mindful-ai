import type { ChatEvent, Conversation, LearningCheckResponse, Message } from '@walden/contracts';
import { conversationTitle } from '@walden/domain';

import { streamChat } from '../../../../../lib/api';
import { id } from '../../../../../lib/ids';
import { track } from '../../../../../lib/telemetry';
import type { ChatAction, ChatPanelProps } from '../../chat-panel-types';
import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatRuntimeState } from '../state/use-chat-runtime-state';
import type { ChatTurnState } from '../state/use-chat-turn';
import { handleLiveChatEvent } from './live-chat-event';

type SendArgs = {
  props: ChatPanelProps;
  display: ChatDisplayState;
  runtime: ChatRuntimeState;
  turn: ChatTurnState;
  effectivePersonaId: string;
  pendingEdit: { id: string; content: string } | null;
  cancelMainTurn(): void;
  resetAnnotationRetries(): void;
  animateAnnotations(messageId: string, values: NonNullable<Message['annotations']>): void;
  adoptIncompleteResponse(
    conversation: Conversation,
    optimistic: Message,
    partialMessage: Message,
    requestId: string,
  ): void;
  launchFollowups(
    messageId: string,
    conversationId: string,
    noteRevision: number | null,
    annotationsHandled?: boolean,
  ): void;
};

type SendStart = {
  clean: string;
  action: ChatAction;
  editMessageId?: string;
  learningCheckResponse?: LearningCheckResponse;
  optimistic: Message;
  preparation: number;
  lifecycle: number;
  preparationScopeId: string | null;
};

type SendRun = SendStart & {
  conversation: Conversation;
  noteRevision: number | null;
  requestController: AbortController;
  requestId: string;
  clearDeadline(): void;
  startedAt: number;
};

function beginSend(
  args: SendArgs,
  message: string,
  action: ChatAction,
  editMessageId?: string,
  learningCheckResponse?: LearningCheckResponse,
): SendStart | null {
  const clean = message.trim();
  if (!clean || args.runtime.sendingRef.current || args.display.savingChatPreference) return null;
  args.runtime.followingResponse.current = true;
  const preparation = ++args.runtime.preparationGeneration.current;
  const lifecycle = args.runtime.lifecycleCancellation.current;
  const optimistic: Message = {
    id: id('local'),
    role: 'user',
    content: clean,
    ...(learningCheckResponse ? { learningCheckResponse } : {}),
    createdAt: new Date().toISOString(),
  };
  args.turn.flushStream();
  args.resetAnnotationRetries();
  args.runtime.sendingRef.current = true;
  if (editMessageId) args.display.setPendingEdit({ id: editMessageId, content: clean });
  else {
    args.runtime.optimisticMessageRef.current = optimistic;
    args.display.setOptimisticMessage(optimistic);
  }
  args.display.setInput('');
  args.display.setSending(true);
  args.display.setStatus('Preparing…');
  args.display.setError('');
  args.display.setInterrupted(false);
  return {
    clean,
    action,
    editMessageId,
    learningCheckResponse,
    optimistic,
    preparation,
    lifecycle,
    preparationScopeId: args.runtime.activeConversationId.current,
  };
}

function resetFailedSend(args: SendArgs, clean: string, error: string) {
  args.display.setError(error);
  args.runtime.sendingRef.current = false;
  args.display.setSending(false);
  args.runtime.optimisticMessageRef.current = null;
  args.display.setOptimisticMessage(null);
  args.display.setPendingEdit(null);
  args.display.setInput(clean);
}

async function waitForPreflight(args: SendArgs, start: SendStart) {
  await args.runtime.pendingTurnCancellation.current;
  const noteRevision = await args.props.onFlush();
  if (
    !args.runtime.mounted.current ||
    args.runtime.lifecycleCancellation.current !== start.lifecycle ||
    args.runtime.preparationGeneration.current !== start.preparation
  )
    return null;
  if (noteRevision === false) {
    resetFailedSend(
      args,
      start.clean,
      'Your note still has unsaved changes. Resolve the save before starting a turn.',
    );
    return null;
  }
  return { noteRevision };
}

async function ensureConversation(args: SendArgs, start: SendStart) {
  try {
    args.runtime.awaitingConversationAdoption.current = start.preparationScopeId === null;
    const conversation = await args.props.onEnsureConversation();
    if (!args.pendingEdit) args.props.onAdvance?.();
    args.runtime.awaitingConversationAdoption.current = false;
    return conversation;
  } catch (cause) {
    args.runtime.awaitingConversationAdoption.current = false;
    if (
      !args.runtime.mounted.current ||
      args.runtime.lifecycleCancellation.current !== start.lifecycle ||
      args.runtime.preparationGeneration.current !== start.preparation
    )
      return null;
    resetFailedSend(
      args,
      start.clean,
      cause instanceof Error ? cause.message : 'The thread could not start.',
    );
    return null;
  }
}

function nameConversation(args: SendArgs, conversation: Conversation, clean: string) {
  if (conversation.title !== 'New thread' && conversation.title !== 'New conversation')
    return conversation;
  const named = { ...conversation, title: conversationTitle(clean) };
  args.runtime.latestConversation.current = named;
  void args.props.onConversation(named);
  return named;
}

function prepareStreamingState(args: SendArgs, conversation: Conversation) {
  args.runtime.streamConversationId.current = conversation.id;
  args.runtime.activeConversationId.current = conversation.id;
  args.turn.streamTarget.current = '';
  args.turn.streamCompletionId.current = null;
  args.turn.displayedStream.current = '';
  args.display.setStreamed('');
  args.display.setStatus('Thinking…');
  args.display.setReasoning('');
  args.display.setLiveTools([]);
  args.display.setLiveSources([]);
  args.display.setLiveContextCompacted(false);
  args.display.setIntervention(null);
  args.display.setLiveAnnotations([]);
  args.display.setRecentAnimation(null);
  if (args.display.recentAnimationTimeout.current !== undefined) {
    window.clearTimeout(args.display.recentAnimationTimeout.current);
    args.display.recentAnimationTimeout.current = undefined;
  }
}

async function prepareSend(args: SendArgs, start: SendStart): Promise<SendRun | null> {
  const preflight = await waitForPreflight(args, start);
  if (!preflight) return null;
  const { noteRevision } = preflight;
  const conversation = await ensureConversation(args, start);
  if (!conversation || !args.runtime.mounted.current) return null;
  if (args.runtime.lifecycleCancellation.current !== start.lifecycle) return null;
  if (
    start.preparationScopeId === null &&
    args.runtime.activeConversationId.current !== null &&
    args.runtime.activeConversationId.current !== conversation.id
  ) {
    args.runtime.sendingRef.current = false;
    args.display.setSending(false);
    args.runtime.optimisticMessageRef.current = null;
    args.display.setOptimisticMessage(null);
    args.display.setPendingEdit(null);
    return null;
  }
  const adopted =
    start.preparationScopeId === null &&
    args.runtime.activeConversationId.current === conversation.id;
  let preparation = start.preparation;
  if (args.runtime.preparationGeneration.current !== preparation) {
    if (!adopted) return null;
    preparation = args.runtime.preparationGeneration.current;
  }
  const named = nameConversation(args, conversation, start.clean);
  prepareStreamingState(args, named);
  const requestController = new AbortController();
  args.runtime.mainAbort.current = requestController;
  const requestId = id('turn');
  args.runtime.activeRequestId.current = requestId;
  const deadline = window.setTimeout(() => {
    if (args.runtime.activeRequestId.current === requestId) args.cancelMainTurn();
    if (args.runtime.activeConversationId.current === named.id)
      args.display.setError('The response timed out. Please try again.');
  }, 315_000);
  const clearDeadline = () => window.clearTimeout(deadline);
  requestController.signal.addEventListener('abort', clearDeadline, { once: true });
  const startedAt = performance.now();
  track('chat_submitted', {
    conversation_id: named.id,
    turn_id: requestId,
    persona_id: args.effectivePersonaId,
    action: start.action,
    characters: start.clean.length,
  });
  return {
    ...start,
    preparation,
    conversation: named,
    noteRevision,
    requestController,
    requestId,
    clearDeadline: () => {
      clearDeadline();
      requestController.signal.removeEventListener('abort', clearDeadline);
    },
    startedAt,
  };
}

function buildCompletedConversation(
  run: SendRun,
  event: Extract<ChatEvent, { type: 'done' }>,
  base: Conversation,
) {
  const editIndex = run.editMessageId
    ? base.messages.findIndex(({ id: messageId }) => messageId === run.editMessageId)
    : -1;
  return {
    ...base,
    id: event.conversationId,
    branchId: event.branchId,
    title: event.title ?? base.title,
    expiresAt: event.expiresAt,
    messages: [
      ...(editIndex >= 0 ? base.messages.slice(0, editIndex) : base.messages),
      run.optimistic,
      event.message,
    ],
  };
}

function drainCompletedResponse(
  args: SendArgs,
  run: SendRun,
  event: Extract<ChatEvent, { type: 'done' }>,
  completed: Conversation,
) {
  if (args.runtime.activeRequestId.current !== run.requestId) return;
  args.turn.streamCompletionId.current = event.message.id;
  args.turn.responseRenderKeys.current.set(event.message.id, run.requestId);
  const latest = args.runtime.latestConversation.current;
  const base = latest?.id === event.conversationId ? latest : completed;
  const editIndex = run.editMessageId
    ? base.messages.findIndex(({ id: messageId }) => messageId === run.editMessageId)
    : -1;
  const messages =
    editIndex >= 0
      ? base.messages.slice(0, editIndex)
      : base.messages.filter(
          (message) => message.id !== run.optimistic.id && message.id !== event.message.id,
        );
  const finalized = {
    ...base,
    id: event.conversationId,
    branchId: event.branchId,
    title: event.title ?? base.title,
    expiresAt: event.expiresAt,
    messages: [...messages, run.optimistic, event.message],
  };
  const deferredAnnotations = args.runtime.pendingAnnotations.current.get(event.message.id);
  const withAnnotations = deferredAnnotations
    ? {
        ...finalized,
        messages: finalized.messages.map((message) =>
          message.id === event.message.id
            ? { ...message, annotations: deferredAnnotations }
            : message,
        ),
      }
    : finalized;
  args.runtime.latestConversation.current = withAnnotations;
  void args.props.onConversation(withAnnotations);
  if (deferredAnnotations) args.animateAnnotations(event.message.id, deferredAnnotations);
  else if (event.message.annotations?.length)
    args.animateAnnotations(event.message.id, event.message.annotations);
  args.display.setOptimisticMessage(null);
  args.runtime.optimisticMessageRef.current = null;
  args.display.setPendingEdit(null);
}

function handleSendDone(args: SendArgs, run: SendRun, event: Extract<ChatEvent, { type: 'done' }>) {
  track('chat_completed', {
    conversation_id: run.conversation.id,
    turn_id: run.requestId,
    duration_ms: Math.round(performance.now() - run.startedAt),
  });
  args.turn.streamTarget.current = event.message.content;
  const latest = args.runtime.latestConversation.current;
  const completed = buildCompletedConversation(
    run,
    event,
    latest?.id === event.conversationId ? latest : run.conversation,
  );
  args.turn.onStreamDrained.current = () => drainCompletedResponse(args, run, event, completed);
  args.turn.displayStreamTarget(event.message.content);
  args.launchFollowups(
    event.message.id,
    event.conversationId,
    run.noteRevision,
    event.annotationsHandled,
  );
}

function handleSendError(
  args: SendArgs,
  run: SendRun,
  event: Extract<ChatEvent, { type: 'error' }>,
) {
  track('chat_failed', {
    conversation_id: run.conversation.id,
    turn_id: run.requestId,
    action: 'server_error',
  });
  if (event.partialMessage)
    args.adoptIncompleteResponse(
      run.conversation,
      run.optimistic,
      event.partialMessage,
      run.requestId,
    );
  args.display.setPendingEdit(null);
  args.display.setError(event.message);
}

function handleSendEvent(args: SendArgs, run: SendRun, event: ChatEvent) {
  if (
    args.runtime.activeConversationId.current !== run.conversation.id ||
    args.runtime.activeRequestId.current !== run.requestId
  )
    return;
  if (handleLiveChatEvent(args, event)) return;
  if (event.type === 'intervention') handleIntervention(args, event.intervention);
  else if (event.type === 'done') handleSendDone(args, run, event);
  else if (event.type === 'error') handleSendError(args, run, event);
}

function handleIntervention(
  args: SendArgs,
  intervention: Extract<ChatEvent, { type: 'intervention' }>['intervention'],
) {
  if (intervention.kind === 'record') args.runtime.pendingRecord.current = intervention.text;
  else if (intervention.kind !== 'ghost' && intervention.kind !== 'learning_check')
    args.display.setIntervention(intervention);
}

async function runSend(args: SendArgs, run: SendRun) {
  try {
    await streamChat(
      {
        requestId: run.requestId,
        conversationId: run.conversation.id,
        branchId: run.conversation.branchId,
        noteRevision: run.noteRevision,
        message: run.clean,
        personaId: args.effectivePersonaId,
        action: run.action,
        ...(run.learningCheckResponse ? { learningCheckResponse: run.learningCheckResponse } : {}),
        ...(run.editMessageId ? { editMessageId: run.editMessageId } : {}),
      },
      (event) => handleSendEvent(args, run, event),
      run.requestController.signal,
    );
  } catch (cause) {
    track('chat_failed', {
      conversation_id: run.conversation.id,
      turn_id: run.requestId,
      action: run.requestController.signal.aborted ? 'cancelled' : 'transport_error',
    });
    if (!run.requestController.signal.aborted)
      args.display.setError(
        cause instanceof Error ? cause.message : 'The response was interrupted.',
      );
    args.display.setPendingEdit(null);
  } finally {
    run.clearDeadline();
    if (
      args.runtime.activeConversationId.current === run.conversation.id &&
      args.runtime.activeRequestId.current === run.requestId
    ) {
      if (args.turn.onStreamDrained.current) args.turn.flushStream();
      args.display.setSending(false);
      args.runtime.sendingRef.current = false;
      args.display.setStatus('');
      if (args.runtime.mainAbort.current === run.requestController)
        args.runtime.mainAbort.current = undefined;
    }
    if (args.runtime.activeRequestId.current === run.requestId)
      args.runtime.streamConversationId.current = null;
  }
}

export function useChatSend(args: SendArgs) {
  async function send(
    message = args.display.input,
    action: ChatAction = 'message',
    editMessageId?: string,
    learningCheckResponse?: LearningCheckResponse,
  ) {
    const start = beginSend(args, message, action, editMessageId, learningCheckResponse);
    if (!start) return;
    const run = await prepareSend(args, start);
    if (run) await runSend(args, run);
  }

  function retryIncomplete(message: Message) {
    const messages = args.runtime.latestConversation.current?.messages ?? [];
    const index = messages.findIndex((item) => item.id === message.id);
    const priorUser = index > 0 ? messages[index - 1] : undefined;
    if (!priorUser || priorUser.role !== 'user') {
      args.display.setError('The original message is no longer available to retry.');
      return;
    }
    void send(priorUser.content, 'message', priorUser.id);
  }

  return { send, retryIncomplete };
}
