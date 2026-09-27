import type {
  Annotation,
  Intervention,
  Message,
  MessageFollowupRequest,
  MessageSource,
  ToolActivity,
} from '@walden/contracts';
import { useCallback, useReducer, useRef, useState } from 'react';
import { upsertActivity } from '../../chat-panel-utils';

export type ProposalNotice = {
  message: string;
  retryable: boolean;
  onRetry?: () => void;
  capture?: { text: string };
};

function useComposerState() {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedMessage, setEditedMessage] = useState('');
  const [autoHighlights, setAutoHighlights] = useState(true);
  const messageInput = useRef<HTMLElement>(null);
  return {
    input,
    setInput,
    attachments,
    setAttachments,
    editingMessageId,
    setEditingMessageId,
    editedMessage,
    setEditedMessage,
    autoHighlights,
    setAutoHighlights,
    messageInput,
  };
}

/** What the in-flight response has produced so far, before it lands in the conversation. */
export type LiveTurn = {
  streamed: string;
  reasoning: string;
  liveTools: ToolActivity[];
  liveSources: MessageSource[];
  liveContextCompacted: boolean;
  status: string;
  liveAnnotations: Annotation[];
};

export type LiveTurnAction =
  /** Clears the live response. Status is kept unless given; annotations unless kept. */
  | { type: 'reset'; status?: string; keepAnnotations?: boolean }
  /** Shows a partial response the server kept after the turn failed. */
  | { type: 'restore'; message: Message }
  | { type: 'streamed'; text: string }
  | { type: 'status'; text: string }
  | { type: 'reasoning'; text: string; append?: boolean }
  | { type: 'tool'; tool: ToolActivity }
  | { type: 'source'; source: MessageSource }
  | { type: 'annotation'; annotation: Annotation }
  | { type: 'context-compacted' };

const EMPTY_LIVE_TURN: LiveTurn = {
  streamed: '',
  reasoning: '',
  liveTools: [],
  liveSources: [],
  liveContextCompacted: false,
  status: '',
  liveAnnotations: [],
};

export function liveTurnReducer(state: LiveTurn, action: LiveTurnAction): LiveTurn {
  switch (action.type) {
    case 'reset':
      return {
        ...EMPTY_LIVE_TURN,
        status: action.status ?? state.status,
        liveAnnotations: action.keepAnnotations ? state.liveAnnotations : [],
      };
    case 'restore':
      return {
        ...state,
        streamed: action.message.content,
        reasoning: action.message.reasoning ?? '',
        liveAnnotations: action.message.annotations ?? [],
        liveTools: action.message.tools ?? [],
        liveSources: action.message.sources ?? [],
        liveContextCompacted: Boolean(action.message.contextCompacted),
      };
    case 'streamed':
      return { ...state, streamed: action.text };
    case 'status':
      return { ...state, status: action.text };
    case 'reasoning':
      return { ...state, reasoning: action.append ? state.reasoning + action.text : action.text };
    case 'tool':
      return { ...state, liveTools: upsertActivity(state.liveTools, action.tool) };
    case 'source':
      return { ...state, liveSources: upsertActivity(state.liveSources, action.source) };
    case 'annotation':
      return { ...state, liveAnnotations: [...state.liveAnnotations, action.annotation] };
    case 'context-compacted':
      return { ...state, liveContextCompacted: true };
  }
}

/** State mirrored into a ref, for code that must read the latest value outside a render. */
function useRefState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set] as const;
}

function useResponseCoreState() {
  const [liveTurn, dispatchLiveTurn] = useReducer(liveTurnReducer, EMPTY_LIVE_TURN);
  const setStreamed = useCallback(
    (text: string) => dispatchLiveTurn({ type: 'streamed', text }),
    [],
  );
  const [error, setError] = useState('');
  const [sending, sendingRef, setSending] = useRefState(false);
  const [interrupted, setInterrupted] = useState(false);
  return {
    ...liveTurn,
    dispatchLiveTurn,
    setStreamed,
    error,
    setError,
    sending,
    sendingRef,
    setSending,
    interrupted,
    setInterrupted,
  };
}

function useResponseActionState() {
  const [proposalMessageId, setProposalMessageId] = useState<string | null>(null);
  const [proposalNotices, setProposalNotices] = useState(new Map<string, ProposalNotice>());
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const [optimisticMessage, optimisticMessageRef, setOptimisticMessage] =
    useRefState<Message | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ id: string; content: string } | null>(null);
  const [intervention, setIntervention] = useState<Exclude<
    Intervention,
    { kind: 'ghost' } | { kind: 'learning_check' }
  > | null>(null);
  const [savingChatPreference, setSavingChatPreference] = useState(false);
  const [recentAnimation, setRecentAnimation] = useState<{
    messageId: string;
    annotationIds: ReadonlySet<string>;
  } | null>(null);
  const [annotationFailures, setAnnotationFailures] = useState<
    Map<string, { input: MessageFollowupRequest; retrying: boolean; message?: string }>
  >(new Map());
  const [backgroundAnnotations, setBackgroundAnnotations] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const recentAnimationTimeout = useRef<number | undefined>(undefined);
  return {
    proposalMessageId,
    setProposalMessageId,
    proposalNotices,
    setProposalNotices,
    regeneratingMessageId,
    setRegeneratingMessageId,
    optimisticMessage,
    optimisticMessageRef,
    setOptimisticMessage,
    pendingEdit,
    setPendingEdit,
    intervention,
    setIntervention,
    savingChatPreference,
    setSavingChatPreference,
    recentAnimation,
    setRecentAnimation,
    annotationFailures,
    setAnnotationFailures,
    backgroundAnnotations,
    setBackgroundAnnotations,
    recentAnimationTimeout,
  };
}

export function useChatDisplayState() {
  return { ...useComposerState(), ...useResponseCoreState(), ...useResponseActionState() };
}

export type ChatDisplayState = ReturnType<typeof useChatDisplayState>;
