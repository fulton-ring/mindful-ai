import type { Annotation, Conversation } from '@walden/contracts';
import { useRef } from 'react';

export function useChatRuntimeState(conversation: Conversation | null, scopeId: string | null) {
  const optimisticMessageRef = useRef<import('@walden/contracts').Message | null>(null);
  const sendingRef = useRef(false);
  const pendingTurnCancellation = useRef<Promise<unknown>>(Promise.resolve());
  const mainAbort = useRef<AbortController | undefined>(undefined);
  const annotationControllers = useRef(new Map<string, AbortController>());
  const proposalAbort = useRef<AbortController | undefined>(undefined);
  const proposalPreparing = useRef(false);
  const proposalPreparationGeneration = useRef(0);
  const preparationGeneration = useRef(0);
  const awaitingConversationAdoption = useRef(false);
  const lifecycleCancellation = useRef(0);
  const mounted = useRef(true);
  const activeRequestId = useRef<string | null>(null);
  const latestConversation = useRef(conversation);
  const lastConversationProp = useRef(conversation);
  const pendingAnnotations = useRef(new Map<string, Annotation[]>());
  const pendingRecord = useRef<string | null>(null);
  const streamConversationId = useRef<string | null>(null);
  const activeConversationId = useRef(scopeId);
  const previousConversationId = useRef(scopeId);
  const activeBranchId = useRef(conversation?.branchId ?? null);
  const previousBranchId = useRef(conversation?.branchId ?? null);
  const scroller = useRef<HTMLDivElement>(null);
  const followingResponse = useRef(true);

  return {
    optimisticMessageRef,
    sendingRef,
    pendingTurnCancellation,
    mainAbort,
    annotationControllers,
    proposalAbort,
    proposalPreparing,
    proposalPreparationGeneration,
    preparationGeneration,
    awaitingConversationAdoption,
    lifecycleCancellation,
    mounted,
    activeRequestId,
    latestConversation,
    lastConversationProp,
    pendingAnnotations,
    pendingRecord,
    streamConversationId,
    activeConversationId,
    previousConversationId,
    activeBranchId,
    previousBranchId,
    scroller,
    followingResponse,
  };
}

export type ChatRuntimeState = ReturnType<typeof useChatRuntimeState>;
