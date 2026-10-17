import type {
  ChatFailureCode,
  ChatRequest,
  Conversation,
  WaldenUIMessage,
} from '@walden/contracts';
import { useRef } from 'react';
import type { UploadedFile } from '../actions/use-chat-uploads';

/** What was in the composer when a turn was sent, restored when nothing reached the server. */
export type SentDraft = { text: string; files: File[]; uploaded: UploadedFile[] };

/** The turn this panel is sending or following, from submit (or resume) until it finishes. */
export type LiveTurn = {
  kind: 'send' | 'regenerate' | 'resume';
  requestId?: string;
  turnId?: string;
  action?: ChatRequest['action'];
  conversationId?: string;
  branchId?: string;
  noteRevision: number | null;
  /** The transcript before this turn; restored when it is refused or a regeneration stops. */
  snapshot: WaldenUIMessage[];
  draft?: SentDraft;
  title?: string;
  expiresAt?: string;
  failureCode?: ChatFailureCode;
  startedAt: number;
};

/** Why the next aborted finish happened; only a Stop turns into an interrupted reply. */
export type AbortReason = 'stop' | 'switch' | 'unmount' | 'replace';

export function useChatRuntimeState(conversation: Conversation | null, scopeId: string | null) {
  return {
    live: useRef<LiveTurn | null>(null),
    abortReason: useRef<AbortReason | null>(null),
    pendingTurnCancellation: useRef<Promise<unknown>>(Promise.resolve()),
    annotationControllers: useRef(new Map<string, AbortController>()),
    proposalAbort: useRef<AbortController | undefined>(undefined),
    proposalPreparing: useRef(false),
    proposalPreparationGeneration: useRef(0),
    awaitingConversationAdoption: useRef(false),
    /** A branch this panel's own finished turn moved to, so arriving there is not a switch. */
    adoptedBranchId: useRef<string | null>(null),
    lifecycleCancellation: useRef(0),
    mounted: useRef(true),
    latestConversation: useRef(conversation),
    lastConversationProp: useRef(conversation),
    activeConversationId: useRef(scopeId),
    previousConversationId: useRef(scopeId),
    activeBranchId: useRef(conversation?.branchId ?? null),
    previousBranchId: useRef(conversation?.branchId ?? null),
    scroller: useRef<HTMLDivElement>(null),
    followingResponse: useRef(true),
  };
}

export type ChatRuntimeState = ReturnType<typeof useChatRuntimeState>;
