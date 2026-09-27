import type { Intervention, MessageFollowupRequest } from '@walden/contracts';
import { useRef, useState } from 'react';

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

function useResponseCoreState() {
  const [error, setError] = useState('');
  /** Transient progress text for the running turn (`data-status`). */
  const [status, setStatus] = useState('');
  return { error, setError, status, setStatus };
}

function useResponseActionState() {
  const [proposalMessageId, setProposalMessageId] = useState<string | null>(null);
  const [proposalNotices, setProposalNotices] = useState(new Map<string, ProposalNotice>());
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
