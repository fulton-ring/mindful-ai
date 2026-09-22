import type {
  Annotation,
  Intervention,
  Message,
  MessageSource,
  ToolActivity,
} from '@walden/contracts';
import { useRef, useState } from 'react';
import type { MessageFollowupRequest } from '../../../../../lib/api';

export type ProposalNotice = {
  message: string;
  retryable: boolean;
  onRetry?: () => void;
  capture?: { text: string };
};

function useComposerState() {
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedMessage, setEditedMessage] = useState('');
  const [autoHighlights, setAutoHighlights] = useState(true);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  return {
    input,
    setInput,
    editingMessageId,
    setEditingMessageId,
    editedMessage,
    setEditedMessage,
    autoHighlights,
    setAutoHighlights,
    messageInput,
  };
}

function useResponseCoreState() {
  const [streamed, setStreamed] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [liveTools, setLiveTools] = useState<ToolActivity[]>([]);
  const [liveSources, setLiveSources] = useState<MessageSource[]>([]);
  const [liveContextCompacted, setLiveContextCompacted] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  return {
    streamed,
    setStreamed,
    reasoning,
    setReasoning,
    liveTools,
    setLiveTools,
    liveSources,
    setLiveSources,
    liveContextCompacted,
    setLiveContextCompacted,
    status,
    setStatus,
    error,
    setError,
    sending,
    setSending,
    interrupted,
    setInterrupted,
  };
}

function useResponseActionState() {
  const [proposalMessageId, setProposalMessageId] = useState<string | null>(null);
  const [proposalNotices, setProposalNotices] = useState(new Map<string, ProposalNotice>());
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const [optimisticMessage, setOptimisticMessage] = useState<Message | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ id: string; content: string } | null>(null);
  const [intervention, setIntervention] = useState<Exclude<
    Intervention,
    { kind: 'ghost' } | { kind: 'learning_check' }
  > | null>(null);
  const [savingChatPreference, setSavingChatPreference] = useState(false);
  const [liveAnnotations, setLiveAnnotations] = useState<Annotation[]>([]);
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
    setOptimisticMessage,
    pendingEdit,
    setPendingEdit,
    intervention,
    setIntervention,
    savingChatPreference,
    setSavingChatPreference,
    liveAnnotations,
    setLiveAnnotations,
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
