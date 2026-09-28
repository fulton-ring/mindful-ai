import { useEffect } from 'react';

import { api } from '../../../../../lib/api';
import type { TurnArgs } from '../session/turn-args';
import { adoptResumedTurn } from '../session/use-chat-session';
import type { AbortReason, ChatRuntimeState } from '../state/use-chat-runtime-state';

/** Stops following the live turn locally; the server turn keeps running. */
function detachTurn(args: TurnArgs, reason: AbortReason) {
  if (args.runtime.live.current) args.runtime.abortReason.current = reason;
  args.runtime.live.current = null;
  void args.chat.stop();
}

function abortFollowups(runtime: ChatRuntimeState) {
  runtime.proposalPreparationGeneration.current += 1;
  runtime.proposalPreparing.current = false;
  for (const controller of runtime.annotationControllers.current.values()) controller.abort();
  runtime.annotationControllers.current.clear();
  runtime.proposalAbort.current?.abort();
}

function resetDisplay(args: TurnArgs) {
  const { display } = args;
  display.setInput('');
  display.setAttachments([]);
  display.setStatus('');
  display.setError('');
  display.setProposalNotices(new Map());
  display.setRecentAnimation(null);
  display.setAnnotationFailures(new Map());
  display.setBackgroundAnnotations(new Set());
  if (display.recentAnimationTimeout.current !== undefined)
    window.clearTimeout(display.recentAnimationTimeout.current);
}

/** Another thread or branch opened: detach, show its messages, and resume its running turn. */
function switchConversation(args: TurnArgs) {
  const { runtime, props, chat } = args;
  runtime.awaitingConversationAdoption.current = false;
  runtime.adoptedBranchId.current = null;
  runtime.followingResponse.current = true;
  detachTurn(args, 'switch');
  abortFollowups(runtime);
  resetDisplay(args);
  chat.setMessages(props.conversation?.messages ?? []);
}

/**
 * Follows a turn still running on the server for the open thread and branch: on
 * open, and whenever the tab comes back into view, since a turn started in
 * another tab is not pushed to this one.
 */
function useResumeEffect(args: TurnArgs) {
  const conversationId = args.props.conversation?.id;
  const branchId = args.props.conversation?.branchId;
  useEffect(() => {
    if (!conversationId || !branchId) return;
    let cancelled = false;
    const resume = () => {
      if (args.runtime.live.current) return;
      void api
        .activeTurn(conversationId, branchId)
        .then(({ turn }) => {
          if (!turn || cancelled || args.runtime.live.current) return;
          adoptResumedTurn(args, turn);
          void args.chat.resumeStream({ body: { turnId: turn.id } });
        })
        .catch(() => undefined);
    };
    const resumeWhenVisible = () => {
      if (document.visibilityState === 'visible') resume();
    };
    resume();
    document.addEventListener('visibilitychange', resumeWhenVisible);
    window.addEventListener('focus', resume);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', resumeWhenVisible);
      window.removeEventListener('focus', resume);
    };
  }, [conversationId, branchId]);
}

/** The new route is this panel's own turn landing: a created thread or a forked branch. */
function isAdoption(runtime: ChatRuntimeState, previousId: string | null, nextId: string | null) {
  const live = runtime.live.current;
  if (previousId === null && nextId !== null)
    return (
      runtime.awaitingConversationAdoption.current ||
      Boolean(live && (!live.conversationId || live.conversationId === nextId))
    );
  return false;
}

function useConversationSwitchEffect(args: TurnArgs) {
  const { props, runtime } = args;
  useEffect(() => {
    const previousId = runtime.previousConversationId.current;
    const previousBranchId = runtime.previousBranchId.current;
    const nextId = props.scopeId;
    const nextBranchId = props.conversation?.branchId ?? null;
    runtime.previousConversationId.current = nextId;
    runtime.previousBranchId.current = nextBranchId;
    if (previousId === nextId && previousBranchId === nextBranchId) return;
    const forked =
      previousId === nextId &&
      nextBranchId !== null &&
      nextBranchId === runtime.adoptedBranchId.current;
    if (forked || isAdoption(runtime, previousId, nextId)) {
      runtime.awaitingConversationAdoption.current = false;
      runtime.adoptedBranchId.current = null;
      return;
    }
    switchConversation(args);
  }, [props.scopeId, props.conversation?.branchId]);
}

/** Saved changes to the conversation (reloads, highlights, annotations) reach an idle transcript. */
function useMessageSyncEffect(args: TurnArgs) {
  const messages = args.props.conversation?.messages;
  useEffect(() => {
    if (!messages || args.runtime.live.current || messages === args.chat.messages) return;
    args.chat.setMessages(messages);
  }, [messages]);
}

function useScrollEffect(args: TurnArgs) {
  const { display, runtime, chat } = args;
  useEffect(() => {
    if (runtime.followingResponse.current && runtime.scroller.current)
      runtime.scroller.current.scrollTo({
        top: runtime.scroller.current.scrollHeight,
        behavior: 'instant',
      });
  }, [chat.messages, display.status]);
}

function useCleanupEffect(args: TurnArgs) {
  const { display, runtime } = args;
  useEffect(() => {
    runtime.mounted.current = true;
    return () => {
      runtime.mounted.current = false;
      runtime.lifecycleCancellation.current += 1;
      detachTurn(args, 'unmount');
      abortFollowups(runtime);
      if (display.recentAnimationTimeout.current !== undefined)
        window.clearTimeout(display.recentAnimationTimeout.current);
    };
  }, []);
}

export function useChatLifecycle(args: TurnArgs) {
  useScrollEffect(args);
  useConversationSwitchEffect(args);
  useMessageSyncEffect(args);
  useResumeEffect(args);
  useCleanupEffect(args);
}
