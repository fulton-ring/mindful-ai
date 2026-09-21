import type { Conversation, Message } from '@walden/contracts';
import { useEffect } from 'react';

import { api } from '../../lib/api';
import { id } from '../../lib/ids';
import type { ChatPanelProps } from './chat-panel-types';
import type { ChatDisplayState } from './use-chat-display-state';
import type { ChatRuntimeState } from './use-chat-runtime-state';
import type { ChatTurnState } from './use-chat-turn';

type LifecycleArgs = {
  props: ChatPanelProps;
  display: ChatDisplayState;
  runtime: ChatRuntimeState;
  turn: ChatTurnState;
  resetAnnotationRetries(): void;
};

function clearLiveResponse(args: LifecycleArgs) {
  const { display, turn } = args;
  turn.onStreamDrained.current = undefined;
  turn.streamTarget.current = '';
  turn.displayedStream.current = '';
  display.setStreamed('');
  display.setReasoning('');
  display.setLiveTools([]);
  display.setLiveSources([]);
  display.setLiveContextCompacted(false);
}

function interruptedMessage(args: LifecycleArgs, content: string): Message {
  const { display } = args;
  return {
    id: id('local-interrupted'),
    role: 'assistant',
    content,
    ...(display.reasoning ? { reasoning: display.reasoning } : {}),
    ...(display.liveTools.length
      ? {
          tools: display.liveTools.map((tool) =>
            tool.state === 'running'
              ? { ...tool, state: 'error' as const, summary: 'Stopped' }
              : tool,
          ),
        }
      : {}),
    ...(display.liveSources.length ? { sources: display.liveSources } : {}),
    ...(display.liveContextCompacted ? { contextCompacted: true } : {}),
    createdAt: new Date().toISOString(),
    incomplete: true,
  };
}

function cancelMainTurn(args: LifecycleArgs, keepalive = false) {
  const { display, runtime } = args;
  const requestId = runtime.activeRequestId.current;
  const requestRunning = Boolean(runtime.mainAbort.current && runtime.sendingRef.current);
  runtime.activeRequestId.current = null;
  runtime.mainAbort.current?.abort();
  runtime.mainAbort.current = undefined;
  if (runtime.mounted.current) {
    display.setSending(false);
    runtime.sendingRef.current = false;
  }
  if (requestId && requestRunning)
    runtime.pendingTurnCancellation.current = api
      .cancelTurn(requestId, keepalive)
      .catch(() => undefined);
}

function stopMainTurn(args: LifecycleArgs) {
  const { display, runtime, turn, props } = args;
  if (display.regeneratingMessageId) {
    clearLiveResponse(args);
    display.setRegeneratingMessageId(null);
    runtime.proposalAbort.current?.abort();
    cancelMainTurn(args);
    return;
  }
  turn.onStreamDrained.current = undefined;
  turn.flushStream();
  const partial = turn.displayedStream.current;
  const optimistic = runtime.optimisticMessageRef.current;
  const current = runtime.latestConversation.current;
  if (current && optimistic) {
    const next = {
      ...current,
      messages: [...current.messages, optimistic, interruptedMessage(args, partial)],
    };
    runtime.latestConversation.current = next;
    void props.onConversation(next);
    runtime.optimisticMessageRef.current = null;
    display.setOptimisticMessage(null);
    clearLiveResponse(args);
    display.setInterrupted(false);
  } else display.setInterrupted(Boolean(partial || display.reasoning));
  runtime.proposalAbort.current?.abort();
  args.resetAnnotationRetries();
  cancelMainTurn(args);
}

function adoptIncompleteResponse(
  args: LifecycleArgs,
  conversation: Conversation,
  optimistic: Message,
  partialMessage: Message,
  requestId: string,
) {
  const { display, runtime, turn, props } = args;
  const current =
    runtime.latestConversation.current?.id === conversation.id
      ? runtime.latestConversation.current
      : conversation;
  turn.streamTarget.current = partialMessage.content;
  turn.displayedStream.current = partialMessage.content;
  display.setStreamed(partialMessage.content);
  display.setReasoning(partialMessage.reasoning ?? '');
  display.setLiveAnnotations(partialMessage.annotations ?? []);
  display.setLiveTools(partialMessage.tools ?? []);
  display.setLiveSources(partialMessage.sources ?? []);
  display.setLiveContextCompacted(Boolean(partialMessage.contextCompacted));
  const adopted = {
    ...current,
    messages: [
      ...current.messages.filter(
        (message) => message.id !== optimistic.id && message.id !== partialMessage.id,
      ),
      optimistic,
      partialMessage,
    ],
  };
  runtime.latestConversation.current = adopted;
  turn.streamCompletionId.current = partialMessage.id;
  turn.responseRenderKeys.current.set(partialMessage.id, requestId);
  void props.onConversation(adopted);
  display.setOptimisticMessage(null);
  runtime.optimisticMessageRef.current = null;
  display.setInterrupted(true);
}

function resetConversationState(args: LifecycleArgs, nextId: string | null) {
  const { display, runtime, turn } = args;
  runtime.awaitingConversationAdoption.current = false;
  runtime.proposalPreparationGeneration.current += 1;
  runtime.proposalPreparing.current = false;
  runtime.preparationGeneration.current += 1;
  runtime.activeConversationId.current = nextId;
  cancelMainTurn(args);
  for (const controller of runtime.annotationControllers.current.values()) controller.abort();
  runtime.annotationControllers.current.clear();
  runtime.proposalAbort.current?.abort();
  runtime.activeRequestId.current = null;
  display.setInput('');
  display.setStreamed('');
  turn.displayedStream.current = '';
  display.setStatus('');
  display.setReasoning('');
  display.setLiveTools([]);
  display.setLiveSources([]);
  display.setLiveContextCompacted(false);
  display.setError('');
  display.setProposalNotices(new Map());
  display.setInterrupted(false);
  display.setOptimisticMessage(null);
  runtime.optimisticMessageRef.current = null;
  display.setIntervention(null);
  display.setLiveAnnotations([]);
  display.setRecentAnimation(null);
  display.setAnnotationFailures(new Map());
  display.setBackgroundAnnotations(new Set());
  turn.streamTarget.current = '';
  turn.streamCompletionId.current = null;
  if (turn.streamFrame.current !== undefined) cancelAnimationFrame(turn.streamFrame.current);
  turn.streamFrame.current = undefined;
  turn.lastStreamFrame.current = undefined;
  turn.onStreamDrained.current = undefined;
  if (display.recentAnimationTimeout.current !== undefined)
    window.clearTimeout(display.recentAnimationTimeout.current);
}

function useScrollEffect(args: LifecycleArgs) {
  const { display, runtime, props } = args;
  useEffect(() => {
    if (runtime.followingResponse.current && runtime.scroller.current)
      runtime.scroller.current.scrollTo({
        top: runtime.scroller.current.scrollHeight,
        behavior: 'instant',
      });
  }, [
    props.conversation?.messages,
    display.optimisticMessage,
    display.streamed,
    display.reasoning,
    display.intervention,
    display.liveTools,
    display.liveSources,
  ]);
}

function useConversationEffect(args: LifecycleArgs) {
  const { props, runtime } = args;
  useEffect(() => {
    const previousId = runtime.previousConversationId.current;
    const nextId = props.scopeId;
    const previousBranchId = runtime.previousBranchId.current;
    const nextBranchId = props.conversation?.branchId ?? null;
    runtime.previousConversationId.current = nextId;
    runtime.previousBranchId.current = nextBranchId;
    const adoptedLazyConversation =
      previousId === null &&
      nextId !== null &&
      (nextId === runtime.streamConversationId.current ||
        runtime.awaitingConversationAdoption.current);
    if ((previousId === nextId && previousBranchId === nextBranchId) || adoptedLazyConversation)
      return;
    runtime.followingResponse.current = true;
    resetConversationState(args, nextId);
  }, [props.scopeId, props.conversation?.branchId, props.conversation?.learningChecksEnabled]);
}

function useCleanupEffects(args: LifecycleArgs) {
  const { display, runtime, turn } = args;
  useEffect(() => {
    runtime.mounted.current = true;
    return () => {
      runtime.mounted.current = false;
      runtime.proposalPreparationGeneration.current += 1;
      runtime.proposalPreparing.current = false;
      runtime.preparationGeneration.current += 1;
      runtime.lifecycleCancellation.current += 1;
      cancelMainTurn(args);
      for (const controller of runtime.annotationControllers.current.values()) controller.abort();
      runtime.annotationControllers.current.clear();
      runtime.proposalAbort.current?.abort();
      if (turn.streamFrame.current !== undefined) cancelAnimationFrame(turn.streamFrame.current);
      if (display.recentAnimationTimeout.current !== undefined)
        window.clearTimeout(display.recentAnimationTimeout.current);
    };
  }, []);
  useEffect(() => {
    const onPageHide = () => {
      runtime.proposalPreparationGeneration.current += 1;
      runtime.proposalPreparing.current = false;
      runtime.preparationGeneration.current += 1;
      runtime.lifecycleCancellation.current += 1;
      cancelMainTurn(args, true);
      for (const controller of runtime.annotationControllers.current.values()) controller.abort();
      runtime.annotationControllers.current.clear();
      runtime.proposalAbort.current?.abort();
    };
    const onVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        turn.streamTarget.current.length > turn.displayedStream.current.length
      )
        turn.displayStreamTarget(turn.streamTarget.current);
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}

export function useChatLifecycle(args: LifecycleArgs) {
  useScrollEffect(args);
  useConversationEffect(args);
  useCleanupEffects(args);
  return {
    cancelMainTurn: () => cancelMainTurn(args),
    stopMainTurn: () => stopMainTurn(args),
    adoptIncompleteResponse: (
      conversation: Conversation,
      optimistic: Message,
      partialMessage: Message,
      requestId: string,
    ) => adoptIncompleteResponse(args, conversation, optimistic, partialMessage, requestId),
  };
}
