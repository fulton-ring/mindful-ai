import type {
  Annotation,
  ChatEvent,
  Conversation,
  EditProposal,
  Intervention,
  Message,
  MessageHighlight,
  MessageSource,
  NoteProposalEvent,
  NoteState,
  Persona,
  ToolActivity,
} from '@walden/contracts';
import { conversationTitle } from '@walden/domain';
import {
  ArrowUp,
  Check,
  Copy,
  FileText,
  Highlighter,
  NotebookPen,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '../../components/ai-elements/reasoning';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import {
  api,
  type MessageFollowupRequest,
  streamChat,
  streamMessageAnnotations,
  streamNoteProposal,
} from '../../lib/api';
import { id } from '../../lib/ids';
import { track } from '../../lib/telemetry';
import { InterventionCard } from '../capture/InterventionCard';
import { AnnotatedText } from '../highlights/AnnotatedText';
import { type ContextualActionId, contextualActionRequest } from '../highlights/contextual-actions';
import { effectivePersona, PersonaPicker } from '../personas/PersonaPicker';
import { BranchSelector } from './BranchSelector';
import { ContextCheckpoint } from './ContextCheckpoint';
import { ResponseActivity, ResponseSources } from './ResponseActivity';

type Props = {
  conversation: Conversation | null;
  scopeId: string | null;
  personas: Persona[];
  personaId: string;
  noteOpen: boolean;
  onPersona(id: string): void;
  onOpenNote(): void;
  onBranch?(id: string): void;
  onEnsureConversation(): Promise<Conversation>;
  /** A new user message is about to advance the conversation, expiring any
   *  undecided note proposal on the server. */
  onAdvance?(): void;
  onConversation(value: Conversation): void | Promise<void>;
  onFlush(): Promise<number | null | false>;
  onProposalStart(sourceId: string): void;
  onProposalCancelable(cancel: (() => Promise<NoteState | null>) | null): void;
  onProposalCancelled?(
    state: NoteState,
    conversationId: string,
    branchId: string,
  ): void | Promise<void>;
  onGhost(
    value: Extract<Intervention, { kind: 'ghost' }>['proposal'] | null,
    streaming: boolean,
    sourceId: string,
  ): void;
  onGhostBatch?(values: EditProposal[], sourceId: string): void;
};
type ProposalNotice = {
  message: string;
  retryable: boolean;
  onRetry?: () => void;
  capture?: { text: string };
};

type MessageStatusRow = {
  key: string;
  message: string;
  alert?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
};

/**
 * The single status surface under a response: progress while work is running,
 * and the failure plus its recovery controls when it is not. Retry and dismiss
 * use the same icon buttons as the response toolbar above so a failure reads as
 * part of the message, not as loose text dropped into the transcript.
 */
function MessageStatus({ rows }: { rows: MessageStatusRow[] }) {
  return (
    <div className="action-notice">
      {rows.map((row) => (
        <p
          key={row.key}
          className={`action-notice__row${row.alert ? ' action-notice__row--alert' : ''}`}
          role={row.alert ? 'alert' : 'status'}
        >
          <span className="action-notice__message">{row.message}</span>
          {row.onRetry && (
            <button
              type="button"
              className="icon-button"
              aria-label={row.retryLabel}
              title={row.retryLabel}
              onClick={row.onRetry}
            >
              <RefreshCw size={14} aria-hidden />
            </button>
          )}
          {row.onDismiss && (
            <button
              type="button"
              className="icon-button"
              aria-label={row.dismissLabel}
              title={row.dismissLabel}
              onClick={row.onDismiss}
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </p>
      ))}
    </div>
  );
}

export function upsertActivity<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
}

export function ChatPanel(props: Props) {
  const selectedPersona = effectivePersona(props.personas, props.personaId);
  const effectivePersonaId = selectedPersona?.id ?? 'thinking-partner';
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedMessage, setEditedMessage] = useState('');
  const [autoHighlights, setAutoHighlights] = useState(true);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const [streamed, setStreamed] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [liveTools, setLiveTools] = useState<ToolActivity[]>([]);
  const [liveSources, setLiveSources] = useState<MessageSource[]>([]);
  const [liveContextCompacted, setLiveContextCompacted] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [proposalMessageId, setProposalMessageId] = useState<string | null>(null);
  const [proposalNotices, setProposalNotices] = useState(new Map<string, ProposalNotice>());
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const [optimisticMessage, setOptimisticMessage] = useState<Message | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ id: string; content: string } | null>(null);
  const optimisticMessageRef = useRef<Message | null>(null);
  const sendingRef = useRef(false);
  const [intervention, setIntervention] = useState<Exclude<Intervention, { kind: 'ghost' }> | null>(
    null,
  );
  const [checksSeen, setChecksSeen] = useState(false);
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
  const copiedMessageTimeout = useRef<number | undefined>(undefined);
  const streamTarget = useRef('');
  const displayedStream = useRef('');
  const streamCompletionId = useRef<string | null>(null);
  const responseRenderKeys = useRef(new Map<string, string>());
  const streamFrame = useRef<number | undefined>(undefined);
  const lastStreamFrame = useRef<number | undefined>(undefined);
  const onStreamDrained = useRef<(() => void) | undefined>(undefined);
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
  const latestConversation = useRef(props.conversation);
  const lastConversationProp = useRef(props.conversation);
  if (props.conversation !== lastConversationProp.current) {
    lastConversationProp.current = props.conversation;
    latestConversation.current = props.conversation;
  }
  const pendingAnnotations = useRef(new Map<string, Annotation[]>());
  /** A record intervention waiting for its turn to finish. */
  const pendingRecord = useRef<string | null>(null);
  const streamConversationId = useRef<string | null>(null);
  const activeConversationId = useRef(props.scopeId);
  const previousConversationId = useRef(props.scopeId);
  const activeBranchId = useRef(props.conversation?.branchId ?? null);
  const previousBranchId = useRef(props.conversation?.branchId ?? null);
  activeBranchId.current = props.conversation?.branchId ?? null;
  if (
    props.scopeId !== null ||
    previousConversationId.current !== null ||
    !streamConversationId.current
  )
    activeConversationId.current = props.scopeId;
  const scroller = useRef<HTMLDivElement>(null);
  const followingResponse = useRef(true);
  function cancelMainTurn(keepalive = false) {
    const requestId = activeRequestId.current;
    const requestRunning = Boolean(mainAbort.current && sendingRef.current);
    activeRequestId.current = null;
    mainAbort.current?.abort();
    mainAbort.current = undefined;
    if (mounted.current) {
      setSending(false);
      sendingRef.current = false;
    }
    if (requestId && requestRunning)
      void api.cancelTurn(requestId, keepalive).catch(() => undefined);
  }
  function stopMainTurn() {
    if (regeneratingMessageId) {
      onStreamDrained.current = undefined;
      streamTarget.current = '';
      displayedStream.current = '';
      setStreamed('');
      setReasoning('');
      setLiveTools([]);
      setLiveSources([]);
      setLiveContextCompacted(false);
      setRegeneratingMessageId(null);
      proposalAbort.current?.abort();
      cancelMainTurn();
      return;
    }
    onStreamDrained.current = undefined;
    flushStream();
    const partial = displayedStream.current;
    const optimistic = optimisticMessageRef.current;
    const current = latestConversation.current;
    if (current && optimistic) {
      const interruptedMessage: Message = {
        id: id('local-interrupted'),
        role: 'assistant',
        content: partial,
        ...(reasoning ? { reasoning } : {}),
        ...(liveTools.length
          ? {
              tools: liveTools.map((tool) =>
                tool.state === 'running'
                  ? { ...tool, state: 'error' as const, summary: 'Stopped' }
                  : tool,
              ),
            }
          : {}),
        ...(liveSources.length ? { sources: liveSources } : {}),
        ...(liveContextCompacted ? { contextCompacted: true } : {}),
        createdAt: new Date().toISOString(),
        incomplete: true,
      };
      const next = {
        ...current,
        messages: [...current.messages, optimistic, interruptedMessage],
      };
      latestConversation.current = next;
      void props.onConversation(next);
      optimisticMessageRef.current = null;
      setOptimisticMessage(null);
      streamTarget.current = '';
      displayedStream.current = '';
      setStreamed('');
      setReasoning('');
      setLiveTools([]);
      setLiveSources([]);
      setLiveContextCompacted(false);
      setInterrupted(false);
    } else setInterrupted(Boolean(partial || reasoning));
    proposalAbort.current?.abort();
    resetAnnotationRetries();
    cancelMainTurn();
  }
  function adoptIncompleteResponse(
    conversation: Conversation,
    optimistic: Message,
    partialMessage: Message,
    requestId: string,
  ) {
    const current =
      latestConversation.current?.id === conversation.id
        ? latestConversation.current
        : conversation;
    const incomplete = partialMessage;
    streamTarget.current = partialMessage.content;
    displayedStream.current = partialMessage.content;
    setStreamed(partialMessage.content);
    setReasoning(partialMessage.reasoning ?? '');
    setLiveAnnotations(partialMessage.annotations ?? []);
    setLiveTools(partialMessage.tools ?? []);
    setLiveSources(partialMessage.sources ?? []);
    setLiveContextCompacted(Boolean(partialMessage.contextCompacted));
    const adopted = {
      ...current,
      messages: [
        ...current.messages.filter(
          (message) => message.id !== optimistic.id && message.id !== incomplete.id,
        ),
        optimistic,
        incomplete,
      ],
    };
    latestConversation.current = adopted;
    streamCompletionId.current = incomplete.id;
    responseRenderKeys.current.set(incomplete.id, requestId);
    void props.onConversation(adopted);
    setOptimisticMessage(null);
    optimisticMessageRef.current = null;
    setInterrupted(true);
  }
  useEffect(() => {
    if (followingResponse.current && scroller.current)
      scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: 'instant' });
  }, [
    props.conversation?.messages,
    optimisticMessage,
    streamed,
    reasoning,
    intervention,
    liveTools,
    liveSources,
  ]);
  useEffect(() => {
    const nextId = props.scopeId;
    const previousId = previousConversationId.current;
    const nextBranchId = props.conversation?.branchId ?? null;
    const priorBranchId = previousBranchId.current;
    previousConversationId.current = nextId;
    previousBranchId.current = nextBranchId;
    const adoptedLazyConversation =
      previousId === null &&
      nextId !== null &&
      (nextId === streamConversationId.current || awaitingConversationAdoption.current);
    if ((previousId === nextId && priorBranchId === nextBranchId) || adoptedLazyConversation)
      return;
    followingResponse.current = true;
    awaitingConversationAdoption.current = false;
    proposalPreparationGeneration.current += 1;
    proposalPreparing.current = false;
    preparationGeneration.current += 1;
    activeConversationId.current = nextId;
    cancelMainTurn();
    for (const controller of annotationControllers.current.values()) controller.abort();
    annotationControllers.current.clear();
    proposalAbort.current?.abort();
    activeRequestId.current = null;
    setInput('');
    setStreamed('');
    displayedStream.current = '';
    setStatus('');
    setReasoning('');
    setLiveTools([]);
    setLiveSources([]);
    setLiveContextCompacted(false);
    setError('');
    setProposalNotices(new Map());
    setInterrupted(false);
    setOptimisticMessage(null);
    optimisticMessageRef.current = null;
    setIntervention(null);
    setChecksSeen(false);
    setLiveAnnotations([]);
    setRecentAnimation(null);
    setAnnotationFailures(new Map());
    setBackgroundAnnotations(new Set());
    streamTarget.current = '';
    streamCompletionId.current = null;
    if (streamFrame.current !== undefined) cancelAnimationFrame(streamFrame.current);
    streamFrame.current = undefined;
    lastStreamFrame.current = undefined;
    onStreamDrained.current = undefined;
    if (recentAnimationTimeout.current !== undefined)
      window.clearTimeout(recentAnimationTimeout.current);
  }, [props.scopeId, props.conversation?.branchId, props.conversation?.learningChecksEnabled]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      proposalPreparationGeneration.current += 1;
      proposalPreparing.current = false;
      preparationGeneration.current += 1;
      lifecycleCancellation.current += 1;
      cancelMainTurn();
      for (const controller of annotationControllers.current.values()) controller.abort();
      annotationControllers.current.clear();
      proposalAbort.current?.abort();
      if (streamFrame.current !== undefined) cancelAnimationFrame(streamFrame.current);
      if (recentAnimationTimeout.current !== undefined)
        window.clearTimeout(recentAnimationTimeout.current);
      if (copiedMessageTimeout.current !== undefined)
        window.clearTimeout(copiedMessageTimeout.current);
    };
  }, []);
  useEffect(() => {
    const onPageHide = () => {
      proposalPreparationGeneration.current += 1;
      proposalPreparing.current = false;
      preparationGeneration.current += 1;
      lifecycleCancellation.current += 1;
      cancelMainTurn(true);
      for (const controller of annotationControllers.current.values()) controller.abort();
      annotationControllers.current.clear();
      proposalAbort.current?.abort();
    };
    const onVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        streamTarget.current.length > displayedStream.current.length
      )
        displayStreamTarget(streamTarget.current);
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }
  function displayStreamTarget(target: string) {
    streamTarget.current = target;
    if (prefersReducedMotion()) {
      displayedStream.current = target;
      setStreamed(target);
      onStreamDrained.current?.();
      onStreamDrained.current = undefined;
      return;
    }
    if (streamFrame.current !== undefined) return;
    const reveal = (timestamp: number) => {
      streamFrame.current = undefined;
      const pending = streamTarget.current.slice(displayedStream.current.length);
      if (!pending) {
        lastStreamFrame.current = undefined;
        onStreamDrained.current?.();
        onStreamDrained.current = undefined;
        return;
      }
      const elapsed = Math.min(100, timestamp - (lastStreamFrame.current ?? timestamp - 16));
      lastStreamFrame.current = timestamp;
      const charactersPerSecond = Math.max(90, pending.length * 6);
      const count = Math.max(1, Math.ceil((elapsed * charactersPerSecond) / 1000));
      const next = displayedStream.current + pending.slice(0, count);
      displayedStream.current = next;
      setStreamed(next);
      if (next.length < streamTarget.current.length)
        streamFrame.current = requestAnimationFrame(reveal);
      else {
        lastStreamFrame.current = undefined;
        onStreamDrained.current?.();
        onStreamDrained.current = undefined;
      }
    };
    streamFrame.current = requestAnimationFrame(reveal);
  }
  function flushStream() {
    if (streamFrame.current !== undefined) cancelAnimationFrame(streamFrame.current);
    streamFrame.current = undefined;
    lastStreamFrame.current = undefined;
    displayedStream.current = streamTarget.current;
    setStreamed(streamTarget.current);
    onStreamDrained.current?.();
    onStreamDrained.current = undefined;
  }
  function animateAnnotations(messageId: string, values: Annotation[]) {
    setRecentAnimation({
      messageId,
      annotationIds: new Set(values.map((annotation) => annotation.id)),
    });
    if (recentAnimationTimeout.current !== undefined)
      window.clearTimeout(recentAnimationTimeout.current);
    recentAnimationTimeout.current = window.setTimeout(() => {
      setRecentAnimation(null);
      recentAnimationTimeout.current = undefined;
    }, 600);
  }
  function mergeAnnotations(messageId: string, values: Annotation[], animate = true) {
    const current = latestConversation.current;
    if (!current?.messages.some((message) => message.id === messageId)) {
      pendingAnnotations.current.set(messageId, values);
      return;
    }
    const previous =
      current.messages.find((message) => message.id === messageId)?.annotations ?? [];
    const previousIds = new Set(previous.map((annotation) => annotation.id));
    const arrivals = values.filter((annotation) => !previousIds.has(annotation.id));
    pendingAnnotations.current.set(messageId, values);
    const next = {
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId ? { ...message, annotations: values } : message,
      ),
    };
    latestConversation.current = next;
    void props.onConversation(next);
    if (animate && arrivals.length) animateAnnotations(messageId, arrivals);
  }
  function mergeAnnotationBatch(current: Annotation[], next: Annotation[]) {
    const seen = new Set(current.map((annotation) => annotation.id));
    return [...current, ...next.filter((annotation) => !seen.has(annotation.id))];
  }
  async function saveHighlight(messageId: string, value: MessageHighlight) {
    const scope = latestConversation.current;
    if (!scope) return;
    const saved = await api.saveHighlight(messageId, value);
    const current = latestConversation.current;
    if (!current || current.id !== scope.id || current.branchId !== scope.branchId) return;
    const next = {
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              highlights: [
                ...(message.highlights ?? []).filter(
                  (item) => item.start !== saved.start || item.end !== saved.end,
                ),
                saved,
              ],
            }
          : message,
      ),
    };
    latestConversation.current = next;
    await props.onConversation(next);
  }
  useEffect(() => {
    const current = props.conversation;
    if (!current) return;
    let next = current;
    let changed = false;
    const arrivals: Array<{ messageId: string; values: Annotation[] }> = [];
    for (const [messageId, values] of pendingAnnotations.current) {
      const target = next.messages.find((message) => message.id === messageId);
      if (!target) continue;
      if (
        target.annotations?.length === values.length &&
        target.annotations.every((annotation, index) => annotation.id === values[index]?.id)
      )
        continue;
      next = {
        ...next,
        messages: next.messages.map((message) =>
          message.id === messageId ? { ...message, annotations: values } : message,
        ),
      };
      // Deliberately kept: this is the last known set for the message, and it
      // has to survive every later write to the conversation, not just the
      // first one. It is cleared when a fresh annotation run starts.
      arrivals.push({ messageId, values });
      changed = true;
    }
    if (!changed) return;
    latestConversation.current = next;
    void props.onConversation(next);
    for (const arrival of arrivals) animateAnnotations(arrival.messageId, arrival.values);
  }, [props.conversation]);
  useEffect(() => {
    const messageId = streamCompletionId.current;
    if (!messageId || !props.conversation?.messages.some((message) => message.id === messageId))
      return;
    streamCompletionId.current = null;
    setStreamed('');
    displayedStream.current = '';
    streamTarget.current = '';
    setLiveAnnotations([]);
    setReasoning('');
    setLiveTools([]);
    setLiveSources([]);
    setLiveContextCompacted(false);
  }, [props.conversation]);
  function clearAnnotationFailure(messageId: string) {
    setAnnotationFailures((current) => {
      if (!current.has(messageId)) return current;
      const next = new Map(current);
      next.delete(messageId);
      return next;
    });
  }
  function resetAnnotationRetries() {
    setAnnotationFailures((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [messageId, failure] of next) {
        if (!failure.retrying) continue;
        changed = true;
        next.set(messageId, { ...failure, retrying: false });
      }
      return changed ? next : current;
    });
  }
  function retryAnnotations(messageId: string, input: MessageFollowupRequest) {
    annotationControllers.current.get(messageId)?.abort();
    const controller = new AbortController();
    annotationControllers.current.set(messageId, controller);
    const conversationId = activeConversationId.current;
    setAnnotationFailures((current) => {
      const next = new Map(current);
      next.set(messageId, { input, retrying: true });
      return next;
    });
    void runAnnotationStream(messageId, input, controller, conversationId)
      .catch((error) => {
        if (
          controller.signal.aborted ||
          annotationControllers.current.get(messageId) !== controller ||
          activeConversationId.current !== conversationId
        )
          return;
        setAnnotationFailures((current) => {
          const next = new Map(current);
          next.set(messageId, {
            input,
            retrying: false,
            message:
              error instanceof Error
                ? error.message
                : 'Highlights could not be generated. Please try again.',
          });
          return next;
        });
      })
      .finally(() => {
        if (annotationControllers.current.get(messageId) === controller)
          annotationControllers.current.delete(messageId);
      });
  }
  async function runAnnotationStream(
    messageId: string,
    input: MessageFollowupRequest,
    controller: AbortController,
    conversationId: string | null,
  ) {
    const baseline =
      latestConversation.current?.messages.find((message) => message.id === messageId)
        ?.annotations ?? [];
    let partial = baseline;
    const isCurrent = () =>
      !controller.signal.aborted &&
      annotationControllers.current.get(messageId) === controller &&
      activeConversationId.current === conversationId;
    try {
      await streamMessageAnnotations(
        messageId,
        input,
        (event) => {
          if (!isCurrent()) return;
          if (event.type === 'annotation') {
            if (partial.some((annotation) => annotation.id === event.annotation.id)) return;
            partial = [...partial, event.annotation];
            mergeAnnotations(messageId, partial);
          } else if (event.type === 'done') {
            partial = mergeAnnotationBatch(partial, event.annotations);
            mergeAnnotations(messageId, partial);
            clearAnnotationFailure(messageId);
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (isCurrent()) mergeAnnotations(messageId, baseline, false);
      throw error;
    }
  }
  function launchFollowups(
    messageId: string,
    conversationId: string,
    noteRevision: number | null,
    sourceId: string,
    annotationsHandled = false,
  ) {
    const input = {
      conversationId,
      branchId: latestConversation.current?.branchId ?? '',
      personaId: effectivePersonaId,
      noteRevision,
    };
    if (autoHighlights && !annotationsHandled) {
      const annotationController = new AbortController();
      // A new run replaces the remembered set; without this a regenerate would
      // keep restoring the previous message's highlights.
      pendingAnnotations.current.delete(messageId);
      annotationControllers.current.set(messageId, annotationController);
      setBackgroundAnnotations((current) => new Set(current).add(messageId));
      void runAnnotationStream(messageId, input, annotationController, conversationId)
        .catch((error) => {
          if (
            annotationController.signal.aborted ||
            annotationControllers.current.get(messageId) !== annotationController ||
            activeConversationId.current !== conversationId
          )
            return;
          setAnnotationFailures((current) => {
            const next = new Map(current);
            next.set(messageId, {
              input,
              retrying: false,
              message:
                error instanceof Error
                  ? error.message
                  : 'Highlights could not be generated. Please try again.',
            });
            return next;
          });
        })
        .finally(() => {
          setBackgroundAnnotations((current) => {
            if (!current.has(messageId)) return current;
            const next = new Set(current);
            next.delete(messageId);
            return next;
          });
          if (annotationControllers.current.get(messageId) === annotationController)
            annotationControllers.current.delete(messageId);
        });
    }

    const record = pendingRecord.current;
    pendingRecord.current = null;
    if (record) void proposeNote(messageId, { text: record });

    // Note suggestions are only ever asked for. Running the proposer on every
    // completed turn meant the reader was handed something to accept or reject
    // after answers that had nothing worth keeping — including, at one point, a
    // proposal about the assistant's own limitations. "Propose note" and "Add
    // to note" remain, and both go through launchNoteProposal below.
  }
  function launchNoteProposal(
    messageId: string,
    conversationId: string,
    input: MessageFollowupRequest,
    sourceId: string,
  ) {
    proposalAbort.current?.abort();
    const proposalController = new AbortController();
    proposalAbort.current = proposalController;
    setProposalMessageId(messageId);
    setProposalNotices((current) => {
      if (!current.has(messageId)) return current;
      const next = new Map(current);
      next.delete(messageId);
      return next;
    });
    const observedAttemptId = { current: null as string | null };
    const launchBranchId = activeBranchId.current ?? latestConversation.current?.branchId ?? null;
    let cancelling: Promise<NoteState | null> | null = null;
    let cancelled = false;
    const cancel = async (): Promise<NoteState | null> => {
      if (cancelling) return cancelling;
      if (!cancelled) {
        if (proposalAbort.current !== proposalController) return null;
        cancelled = true;
        proposalController.abort();
        proposalAbort.current = undefined;
        props.onProposalCancelable(null);
        setProposalMessageId((current) => (current === messageId ? null : current));
        props.onGhost(null, false, sourceId);
      }
      const attemptId = observedAttemptId.current;
      if (!attemptId) return null;
      const branchId = launchBranchId;
      if (!branchId) return null;
      cancelling = api
        .cancelNoteProposal(messageId, { conversationId, branchId, attemptId })
        .then(async (result) => {
          if (
            activeConversationId.current === conversationId &&
            activeBranchId.current === branchId
          ) {
            setProposalNotices((current) => {
              if (!current.has(messageId)) return current;
              const next = new Map(current);
              next.delete(messageId);
              return next;
            });
          }
          if (
            result.noteState &&
            activeConversationId.current === conversationId &&
            activeBranchId.current === branchId
          ) {
            await props.onProposalCancelled?.(result.noteState, conversationId, branchId);
          }
          return result.noteState;
        })
        .catch(() => {
          if (
            activeConversationId.current === conversationId &&
            activeBranchId.current === branchId
          ) {
            setProposalNotices((current) =>
              new Map(current).set(messageId, {
                message: 'The note suggestion could not be cancelled. Please try again.',
                retryable: true,
                onRetry: () => void cancel(),
              }),
            );
          }
          return null;
        })
        .finally(() => {
          cancelling = null;
        });
      return cancelling;
    };
    props.onProposalCancelable(cancel);
    props.onProposalStart(sourceId);
    const retryCapture =
      input.action === 'capture' && input.captureText ? { text: input.captureText } : undefined;
    /** Whether the stream said how it finished. */
    let settled = false;
    /** Previews seen, so an unterminated stream can still be completed with them. */
    const previews = new Map<string, EditProposal>();
    void streamNoteProposal(
      messageId,
      input,
      (event: NoteProposalEvent) => {
        if (proposalController.signal.aborted || activeConversationId.current !== conversationId)
          return;
        if (event.type === 'preview') {
          observedAttemptId.current ??= event.proposal.id.replace(/:\d+$/, '');
          previews.set(event.proposal.id, event.proposal);
          props.onGhost(event.proposal, true, sourceId);
        } else if (event.type === 'done') {
          settled = true;
          if (event.proposals && props.onGhostBatch) props.onGhostBatch(event.proposals, sourceId);
          else props.onGhost(event.proposal, false, sourceId);
          const noopReason = event.reason;
          if (sourceId.startsWith('proposal-manual') && !event.proposal && noopReason)
            setProposalNotices((current) =>
              new Map(current).set(messageId, {
                message: noopReason,
                retryable: false,
                ...(retryCapture ? { capture: retryCapture } : {}),
                // A decline is the usual answer to "Add to note", so it has to
                // report where the reader asked — the selection menu — rather
                // than under the response, which is where every notice without
                // this marker goes.
              }),
            );
        } else {
          settled = true;
          props.onGhost(null, false, sourceId);
          setProposalNotices((current) =>
            new Map(current).set(messageId, {
              message: event.message,
              retryable: true,
              ...(retryCapture ? { capture: retryCapture } : {}),
            }),
          );
        }
      },
      proposalController.signal,
    )
      .catch((error) => {
        settled = true;
        if (!proposalController.signal.aborted && activeConversationId.current === conversationId) {
          props.onGhost(null, false, sourceId);
          setProposalNotices((current) =>
            new Map(current).set(messageId, {
              message:
                error instanceof Error
                  ? error.message
                  : 'The note suggestion was interrupted. Please try again.',
              retryable: true,
              ...(retryCapture ? { capture: retryCapture } : {}),
            }),
          );
        }
      })
      .finally(() => {
        if (proposalAbort.current === proposalController) {
          proposalAbort.current = undefined;
          props.onProposalCancelable(null);
        }
        setProposalMessageId((current) => (current === messageId ? null : current));
        if (
          settled ||
          proposalController.signal.aborted ||
          activeConversationId.current !== conversationId
        )
          return;
        // The stream ended without saying how it finished. A stream that has
        // ended is finished, so it is completed with whatever arrived — the
        // suggestions are already saved server-side. Waiting for a `done` that
        // was never coming left the editor on "Suggesting…" with accepting
        // disabled until the reader reloaded the page.
        const arrived = [...previews.values()];
        if (arrived.length && props.onGhostBatch) props.onGhostBatch(arrived, sourceId);
        else props.onGhost(arrived.at(-1) ?? null, false, sourceId);
      });
  }
  async function proposeNote(messageId: string, capture?: { text: string }) {
    const conversationId = activeConversationId.current;
    if (!conversationId || proposalAbort.current || proposalPreparing.current) return;
    props.onOpenNote();
    proposalPreparing.current = true;
    const preparation = ++proposalPreparationGeneration.current;
    const lifecycle = lifecycleCancellation.current;
    setProposalNotices((current) => {
      if (!current.has(messageId)) return current;
      const next = new Map(current);
      next.delete(messageId);
      return next;
    });
    const noteRevision = await props.onFlush();
    if (proposalPreparationGeneration.current === preparation) proposalPreparing.current = false;
    if (
      noteRevision === false ||
      proposalPreparationGeneration.current !== preparation ||
      lifecycleCancellation.current !== lifecycle ||
      activeConversationId.current !== conversationId
    ) {
      // Report a blocked proposal on the response it belongs to, rather than
      // leaving the button looking inert.
      if (noteRevision === false)
        setProposalNotices((current) => {
          const next = new Map(current);
          next.set(messageId, {
            message: 'Your note still has unsaved changes. Resolve the save, then try again.',
            retryable: true,
            ...(capture ? { capture } : {}),
          });
          return next;
        });
      return;
    }
    launchNoteProposal(
      messageId,
      conversationId,
      {
        conversationId,
        branchId: latestConversation.current?.branchId ?? '',
        personaId: effectivePersonaId,
        noteRevision,
        noteProposalRequested: true,
        ...(capture ? { action: 'capture' as const, captureText: capture.text } : {}),
      },
      id('proposal-manual'),
    );
  }
  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      if (copiedMessageTimeout.current !== undefined)
        window.clearTimeout(copiedMessageTimeout.current);
      copiedMessageTimeout.current = window.setTimeout(
        () => setCopiedMessageId((current) => (current === message.id ? null : current)),
        1600,
      );
    } catch {
      setError('The response could not be copied.');
    }
  }
  /**
   * Retry a response that never completed. The server refuses to regenerate an
   * incomplete message, so this resends the user's prior message unchanged
   * through the edit path, which replaces the failed turn in place instead of
   * appending a second copy of the question.
   */
  function retryIncomplete(message: Message) {
    const messages = latestConversation.current?.messages ?? [];
    const index = messages.findIndex((item) => item.id === message.id);
    const priorUser = index > 0 ? messages[index - 1] : undefined;
    if (!priorUser || priorUser.role !== 'user') {
      setError('The original message is no longer available to retry.');
      return;
    }
    void send(priorUser.content, 'message', priorUser.id);
  }

  async function regenerateResponse(message: Message) {
    const conversation = latestConversation.current;
    if (!conversation || sendingRef.current) return;
    const targetIndex = conversation.messages.findIndex((item) => item.id === message.id);
    const priorUser = conversation.messages[targetIndex - 1];
    if (!priorUser || priorUser.role !== 'user') return;
    sendingRef.current = true;
    setSending(true);
    proposalAbort.current?.abort();
    annotationControllers.current.get(message.id)?.abort();
    annotationControllers.current.delete(message.id);
    const preparation = ++preparationGeneration.current;
    const lifecycle = lifecycleCancellation.current;
    const preparationController = new AbortController();
    mainAbort.current = preparationController;
    const noteRevision = await props.onFlush();
    if (
      noteRevision === false ||
      preparationController.signal.aborted ||
      preparationGeneration.current !== preparation ||
      lifecycleCancellation.current !== lifecycle ||
      activeConversationId.current !== conversation.id
    ) {
      if (mainAbort.current === preparationController) mainAbort.current = undefined;
      sendingRef.current = false;
      setSending(false);
      // An unsaved note blocks regeneration the same way it blocks sending.
      // Say so: otherwise the button looks like it does nothing at all.
      if (noteRevision === false)
        setError('Your note still has unsaved changes. Resolve the save before regenerating.');
      return;
    }
    setRegeneratingMessageId(message.id);
    setError('');
    setStatus('Regenerating…');
    setLiveAnnotations([]);
    setReasoning('');
    setLiveTools([]);
    setLiveSources([]);
    setLiveContextCompacted(false);
    streamTarget.current = '';
    streamCompletionId.current = null;
    displayedStream.current = '';
    setStreamed('');
    const requestController = preparationController;
    mainAbort.current = requestController;
    const requestId = id('turn');
    activeRequestId.current = requestId;
    try {
      await streamChat(
        {
          requestId,
          conversationId: conversation.id,
          branchId: conversation.branchId,
          noteRevision,
          message: priorUser.content,
          personaId: effectivePersonaId,
          action: 'message',
          regenerateMessageId: message.id,
        },
        (event) => {
          if (
            requestController.signal.aborted ||
            activeRequestId.current !== requestId ||
            activeConversationId.current !== conversation.id
          )
            return;
          if (event.type === 'text') displayStreamTarget(streamTarget.current + event.text);
          else if (event.type === 'reasoning') setReasoning((current) => current + event.text);
          else if (event.type === 'tool')
            setLiveTools((current) => upsertActivity(current, event.tool));
          else if (event.type === 'source')
            setLiveSources((current) => upsertActivity(current, event.source));
          else if (event.type === 'status') setStatus(event.text);
          else if (event.type === 'context-compacted') setLiveContextCompacted(true);
          else if (event.type === 'annotation')
            setLiveAnnotations((current) => [...current, event.annotation]);
          else if (event.type === 'done') {
            streamTarget.current = event.message.content;
            onStreamDrained.current = () => {
              if (activeRequestId.current !== requestId) return;
              streamCompletionId.current = event.message.id;
              responseRenderKeys.current.set(event.message.id, requestId);
              const current = latestConversation.current ?? conversation;
              const next = {
                ...current,
                branchId: event.branchId,
                title: event.title ?? current.title,
                expiresAt: event.expiresAt,
                messages: [...current.messages.slice(0, targetIndex), event.message],
              };
              latestConversation.current = next;
              if (event.message.annotations?.length)
                animateAnnotations(event.message.id, event.message.annotations);
              void Promise.resolve(props.onConversation(next)).then(() => {
                if (
                  activeConversationId.current === conversation.id &&
                  activeBranchId.current === event.branchId
                )
                  launchFollowups(
                    event.message.id,
                    conversation.id,
                    noteRevision,
                    requestId,
                    event.annotationsHandled,
                  );
              });
              setRegeneratingMessageId(null);
            };
            displayStreamTarget(event.message.content);
          } else if (event.type === 'error') setError(event.message);
        },
        requestController.signal,
      );
    } catch (cause) {
      if (!requestController.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'The response could not be regenerated.');
    } finally {
      if (activeRequestId.current === requestId) {
        setSending(false);
        sendingRef.current = false;
        setStatus('');
        if (!onStreamDrained.current) {
          setRegeneratingMessageId(null);
          setStreamed('');
          setReasoning('');
          setLiveTools([]);
          setLiveSources([]);
          setLiveContextCompacted(false);
        }
      }
      if (mainAbort.current === requestController) mainAbort.current = undefined;
    }
  }
  async function send(
    message = input,
    action: 'message' | 'challenge' | 'source' | 'capture' | 'feedback' | 'stop_checks' = 'message',
    editMessageId?: string,
  ) {
    const clean = message.trim();
    if (!clean || sendingRef.current) return;
    followingResponse.current = true;
    let preparation = ++preparationGeneration.current;
    const lifecycle = lifecycleCancellation.current;
    const preparationScopeId = activeConversationId.current;
    flushStream();
    resetAnnotationRetries();
    sendingRef.current = true;
    const optimistic: Message = {
      id: id('local'),
      role: 'user',
      content: clean,
      createdAt: new Date().toISOString(),
    };
    if (editMessageId) {
      setPendingEdit({ id: editMessageId, content: clean });
    } else {
      optimisticMessageRef.current = optimistic;
      setOptimisticMessage(optimistic);
    }
    setInput('');
    setSending(true);
    setStatus('Preparing…');
    setError('');
    setInterrupted(false);
    const noteRevision = await props.onFlush();
    if (
      !mounted.current ||
      lifecycleCancellation.current !== lifecycle ||
      preparationGeneration.current !== preparation
    )
      return;
    if (noteRevision === false) {
      setError('Your note still has unsaved changes. Resolve the save before starting a turn.');
      sendingRef.current = false;
      setSending(false);
      optimisticMessageRef.current = null;
      setOptimisticMessage(null);
      setPendingEdit(null);
      setInput(clean);
      return;
    }
    let conversation: Conversation;
    try {
      awaitingConversationAdoption.current = preparationScopeId === null;
      conversation = await props.onEnsureConversation();
      if (!pendingEdit) props.onAdvance?.();
      awaitingConversationAdoption.current = false;
    } catch (cause) {
      awaitingConversationAdoption.current = false;
      if (
        !mounted.current ||
        lifecycleCancellation.current !== lifecycle ||
        preparationGeneration.current !== preparation
      )
        return;
      setError(cause instanceof Error ? cause.message : 'The thread could not start.');
      sendingRef.current = false;
      setSending(false);
      optimisticMessageRef.current = null;
      setOptimisticMessage(null);
      setPendingEdit(null);
      setInput(clean);
      return;
    }
    if (!mounted.current || lifecycleCancellation.current !== lifecycle) return;
    if (
      preparationScopeId === null &&
      activeConversationId.current !== null &&
      activeConversationId.current !== conversation.id
    ) {
      sendingRef.current = false;
      setSending(false);
      optimisticMessageRef.current = null;
      setOptimisticMessage(null);
      setPendingEdit(null);
      return;
    }
    const adoptedPreparedConversation =
      preparationScopeId === null && activeConversationId.current === conversation.id;
    if (preparationGeneration.current !== preparation) {
      if (!adoptedPreparedConversation) return;
      preparation = preparationGeneration.current;
    }
    // Name the thread now rather than at the end of the turn. The title is
    // derived from the message the reader just sent, so both sides compute the
    // same thing and the sidebar stops saying "New thread" while the answer is
    // still streaming.
    if (conversation.title === 'New thread' || conversation.title === 'New conversation') {
      const named = { ...conversation, title: conversationTitle(clean) };
      latestConversation.current = named;
      void props.onConversation(named);
      conversation = named;
    }
    streamConversationId.current = conversation.id;
    activeConversationId.current = conversation.id;
    streamTarget.current = '';
    streamCompletionId.current = null;
    displayedStream.current = '';
    setStreamed('');
    setStatus('Thinking…');
    setReasoning('');
    setLiveTools([]);
    setLiveSources([]);
    setLiveContextCompacted(false);
    setIntervention(null);
    setLiveAnnotations([]);
    setRecentAnimation(null);
    if (recentAnimationTimeout.current !== undefined) {
      window.clearTimeout(recentAnimationTimeout.current);
      recentAnimationTimeout.current = undefined;
    }
    const requestController = new AbortController();
    mainAbort.current = requestController;
    const requestId = id('turn');
    activeRequestId.current = requestId;
    const deadline = window.setTimeout(() => {
      if (activeRequestId.current === requestId) cancelMainTurn();
      if (activeConversationId.current === conversation.id)
        setError('The response timed out. Please try again.');
    }, 90_000);
    const clearDeadline = () => window.clearTimeout(deadline);
    requestController.signal.addEventListener('abort', clearDeadline, { once: true });
    const startedAt = performance.now();
    track('chat_submitted', {
      conversation_id: conversation.id,
      turn_id: requestId,
      persona_id: effectivePersonaId,
      action,
      characters: clean.length,
    });
    try {
      await streamChat(
        {
          requestId,
          conversationId: conversation.id,
          branchId: conversation.branchId,
          noteRevision,
          message: clean,
          personaId: effectivePersonaId,
          action,
          ...(editMessageId ? { editMessageId } : {}),
        },
        (event: ChatEvent) => {
          if (
            activeConversationId.current !== conversation.id ||
            activeRequestId.current !== requestId
          )
            return;
          if (event.type === 'text') displayStreamTarget(streamTarget.current + event.text);
          else if (event.type === 'status') setStatus(event.text);
          else if (event.type === 'context-compacted') setLiveContextCompacted(true);
          else if (event.type === 'reasoning') setReasoning((current) => current + event.text);
          else if (event.type === 'tool')
            setLiveTools((current) => upsertActivity(current, event.tool));
          else if (event.type === 'source')
            setLiveSources((current) => upsertActivity(current, event.source));
          else if (event.type === 'annotation') {
            setLiveAnnotations((current) => [...current, event.annotation]);
          } else if (event.type === 'intervention') {
            // A record arrives mid-turn, before there is a response to hang a
            // proposal on, so it waits for the turn to finish and then goes
            // through the one proposal pipeline like every other capture.
            if (event.intervention.kind === 'record')
              pendingRecord.current = event.intervention.text;
            else if (event.intervention.kind !== 'ghost') {
              if (event.intervention.kind === 'learning_check') setChecksSeen(true);
              setIntervention(event.intervention);
            }
          } else if (event.type === 'done') {
            track('chat_completed', {
              conversation_id: conversation.id,
              turn_id: requestId,
              duration_ms: Math.round(performance.now() - startedAt),
            });
            streamTarget.current = event.message.content;
            const latest = latestConversation.current;
            const baseConversation = latest?.id === event.conversationId ? latest : conversation;
            const editIndex = editMessageId
              ? baseConversation.messages.findIndex(({ id }) => id === editMessageId)
              : -1;
            const completedConversation: Conversation = {
              ...baseConversation,
              id: event.conversationId,
              branchId: event.branchId,
              title: event.title ?? baseConversation.title,
              expiresAt: event.expiresAt,
              messages: [
                ...(editIndex >= 0
                  ? baseConversation.messages.slice(0, editIndex)
                  : baseConversation.messages),
                optimistic,
                event.message,
              ],
            };
            onStreamDrained.current = () => {
              if (activeRequestId.current !== requestId) return;
              streamCompletionId.current = event.message.id;
              responseRenderKeys.current.set(event.message.id, requestId);
              const latestAtDrain = latestConversation.current;
              const baseAtDrain =
                latestAtDrain?.id === event.conversationId ? latestAtDrain : completedConversation;
              const editIndexAtDrain = editMessageId
                ? baseAtDrain.messages.findIndex(({ id }) => id === editMessageId)
                : -1;
              const drainedConversation: Conversation = {
                ...baseAtDrain,
                id: event.conversationId,
                branchId: event.branchId,
                title: event.title ?? baseAtDrain.title,
                expiresAt: event.expiresAt,
                messages: [
                  ...(editIndexAtDrain >= 0
                    ? baseAtDrain.messages.slice(0, editIndexAtDrain)
                    : baseAtDrain.messages.filter(
                        (message) =>
                          message.id !== optimistic.id && message.id !== event.message.id,
                      )),
                  optimistic,
                  event.message,
                ],
              };
              const deferredAnnotations = pendingAnnotations.current.get(event.message.id);
              const finalized = deferredAnnotations
                ? {
                    ...drainedConversation,
                    messages: drainedConversation.messages.map((message) =>
                      message.id === event.message.id
                        ? { ...message, annotations: deferredAnnotations }
                        : message,
                    ),
                  }
                : drainedConversation;
              latestConversation.current = finalized;
              void props.onConversation(finalized);
              if (deferredAnnotations) animateAnnotations(event.message.id, deferredAnnotations);
              else if (event.message.annotations?.length)
                animateAnnotations(event.message.id, event.message.annotations);
              setOptimisticMessage(null);
              optimisticMessageRef.current = null;
              setPendingEdit(null);
            };
            displayStreamTarget(event.message.content);
            launchFollowups(
              event.message.id,
              event.conversationId,
              noteRevision,
              requestId,
              event.annotationsHandled,
            );
          } else if (event.type === 'error') {
            track('chat_failed', {
              conversation_id: conversation.id,
              turn_id: requestId,
              action: 'server_error',
            });
            if (event.partialMessage)
              adoptIncompleteResponse(conversation, optimistic, event.partialMessage, requestId);
            setPendingEdit(null);
            setError(event.message);
          }
        },
        requestController.signal,
      );
    } catch (cause) {
      track('chat_failed', {
        conversation_id: conversation.id,
        turn_id: requestId,
        action: requestController.signal.aborted ? 'cancelled' : 'transport_error',
      });
      if (!requestController.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'The response was interrupted.');
      setPendingEdit(null);
    } finally {
      clearDeadline();
      requestController.signal.removeEventListener('abort', clearDeadline);
      if (
        activeConversationId.current === conversation.id &&
        activeRequestId.current === requestId
      ) {
        setSending(false);
        sendingRef.current = false;
        setStatus('');
        if (mainAbort.current === requestController) mainAbort.current = undefined;
      }
      if (activeRequestId.current === requestId) streamConversationId.current = null;
    }
  }
  /**
   * Progress or failure for a capture asked for from a message's selection
   * menu, reported back into that menu rather than a row under the message.
   */
  function captureStatus(messageId: string) {
    const pending = proposalMessageId === messageId;
    const notice = proposalNotices.get(messageId);
    if (!pending && !notice?.capture) return null;
    return {
      pending,
      ...(notice?.capture
        ? {
            message: notice.message,
            alert: notice.retryable,
            ...(notice.retryable
              ? {
                  onRetry: () =>
                    notice.onRetry ? notice.onRetry() : void proposeNote(messageId, notice.capture),
                }
              : {}),
            onDismiss: () => dismissProposalNotice(messageId),
          }
        : {}),
    };
  }
  function dismissProposalNotice(messageId: string) {
    setProposalNotices((current) => {
      if (!current.has(messageId)) return current;
      const next = new Map(current);
      next.delete(messageId);
      return next;
    });
  }
  function contextual(messageId: string | null, action: ContextualActionId, quote: string) {
    if (action === 'capture') {
      if (!messageId) {
        setError('Wait for the response to finish before adding it to your note.');
        return;
      }
      void proposeNote(messageId, { text: quote });
      return;
    }
    const request = contextualActionRequest(action, quote);
    if (request) void send(request.prompt, request.intent);
  }
  const hasConversationActivity =
    (props.conversation?.messages.length ?? 0) > 0 || Boolean(optimisticMessage) || sending;
  const latestCompletedAssistantId = [...(props.conversation?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant' && !message.incomplete)?.id;
  function highlightMessage(messageId: string) {
    const conversationId = activeConversationId.current;
    if (!conversationId || annotationControllers.current.has(messageId)) return;
    retryAnnotations(messageId, {
      conversationId,
      branchId: latestConversation.current?.branchId ?? '',
      personaId: effectivePersonaId,
      noteRevision: null,
    });
  }
  function messageToolbar(message: Message) {
    const proposing = proposalMessageId === message.id;
    const notice = proposalNotices.get(message.id);
    const highlighting =
      backgroundAnnotations.has(message.id) || annotationFailures.get(message.id)?.retrying;
    const highlightFailure = annotationFailures.get(message.id);
    // One status surface per response. Progress, failures and retries all sit
    // in the same place with the same controls, rather than each path inventing
    // its own row of text links.
    const statusRows: MessageStatusRow[] = [];
    if (highlighting) statusRows.push({ key: 'highlighting', message: 'Adding highlights…' });
    else if (highlightFailure)
      statusRows.push({
        key: 'highlight-failure',
        alert: true,
        message: highlightFailure.message ?? 'Highlights could not be generated. Please try again.',
        onRetry: () => retryAnnotations(message.id, highlightFailure.input),
        retryLabel: 'Retry highlights',
        onDismiss: () => clearAnnotationFailure(message.id),
        dismissLabel: 'Dismiss highlight error',
      });
    // A capture asked for from the selection menu reports back into that menu,
    // so it is not repeated here.
    if (notice && !notice.capture)
      statusRows.push({
        key: 'note-notice',
        alert: notice.retryable,
        message: notice.message,
        ...(notice.retryable
          ? {
              onRetry: () =>
                notice.onRetry ? notice.onRetry() : void proposeNote(message.id, notice.capture),
              retryLabel: 'Retry note proposal',
            }
          : {}),
        onDismiss: () =>
          setProposalNotices((current) => {
            const next = new Map(current);
            next.delete(message.id);
            return next;
          }),
        dismissLabel: 'Dismiss note proposal status',
      });
    return (
      <div className="message-actions">
        <TooltipProvider delayDuration={250}>
          <div className="message-toolbar" aria-label="Response actions">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Highlight response"
                  disabled={highlighting}
                  onClick={() => highlightMessage(message.id)}
                >
                  <Highlighter aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent className="annotation-tooltip">Highlight</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="toolbar-tooltip-trigger" tabIndex={-1}>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Regenerate response"
                    disabled={sending}
                    onClick={() => void regenerateResponse(message)}
                  >
                    <RefreshCw aria-hidden />
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="annotation-tooltip">Regenerate from here</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={copiedMessageId === message.id ? 'Copied response' : 'Copy response'}
                  onClick={() => void copyMessage(message)}
                >
                  {copiedMessageId === message.id ? <Check aria-hidden /> : <Copy aria-hidden />}
                </button>
              </TooltipTrigger>
              <TooltipContent className="annotation-tooltip">
                {copiedMessageId === message.id ? 'Copied' : 'Copy Markdown'}
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
        {statusRows.length > 0 && <MessageStatus rows={statusRows} />}
      </div>
    );
  }
  const conversationMessages = props.conversation?.messages ?? [];
  const regenerationIndex = regeneratingMessageId
    ? conversationMessages.findIndex(({ id }) => id === regeneratingMessageId)
    : -1;
  const visibleMessages =
    regenerationIndex >= 0
      ? conversationMessages.slice(0, regenerationIndex)
      : conversationMessages;
  const hasLiveResponse = Boolean(
    streamed || reasoning || liveTools.length || liveSources.length || liveContextCompacted,
  );
  const liveResponseId = activeRequestId.current ?? 'streaming-response';
  const renderedMessages = visibleMessages.filter(
    (message) => message.id !== streamCompletionId.current && message.id !== optimisticMessage?.id,
  );
  if (pendingEdit) {
    const editIndex = renderedMessages.findIndex(({ id }) => id === pendingEdit.id);
    if (editIndex >= 0) {
      const original = renderedMessages[editIndex];
      renderedMessages.splice(editIndex, renderedMessages.length - editIndex, {
        ...original,
        content: pendingEdit.content,
      });
    }
  } else if (optimisticMessage) renderedMessages.push(optimisticMessage);
  if (hasLiveResponse)
    renderedMessages.push({
      id: liveResponseId,
      role: 'assistant',
      content: streamed,
      reasoning,
      annotations: liveAnnotations,
      tools: liveTools,
      sources: liveSources,
      contextCompacted: liveContextCompacted,
      incomplete: interrupted,
      createdAt: '',
    });
  return (
    <aside
      className={`chat-panel ${hasConversationActivity ? '' : 'empty-conversation'}`}
      aria-label="Thread"
    >
      {!props.noteOpen && (
        <button
          type="button"
          className="open-note-button inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm"
          onClick={props.onOpenNote}
        >
          <FileText size={16} aria-hidden /> Open note
        </button>
      )}
      <div
        ref={scroller}
        className={`chat-scroll ${hasConversationActivity ? '' : 'is-empty'}`}
        aria-live="polite"
        onWheel={(event) => {
          if (event.deltaY < 0) followingResponse.current = false;
        }}
        onScroll={(event) => {
          const panel = event.currentTarget;
          followingResponse.current =
            panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 2;
        }}
      >
        <div className="chat-content">
          {props.conversation && (
            <BranchSelector
              branches={props.conversation.branches}
              selectedId={props.conversation.branchId}
              onSelect={(id) => props.onBranch?.(id)}
            />
          )}
          {!hasConversationActivity && (
            <div className="chat-empty">
              <h2>What’s on your mind?</h2>
            </div>
          )}
          {renderedMessages.map((message, index) => {
            const isLive = hasLiveResponse && message.id === liveResponseId;
            return (
              <Fragment key={responseRenderKeys.current.get(message.id) ?? message.id}>
                {message.role === 'assistant' && message.contextCompacted && <ContextCheckpoint />}
                <article className={`message ${message.role}`}>
                  {message.role === 'assistant' ? (
                    <>
                      <p className="message-sender">
                        {message.personaName ?? selectedPersona?.name ?? 'Assistant'}
                      </p>
                      <ResponseActivity tools={message.tools} live={isLive && sending} />
                      {message.reasoning && (
                        <Reasoning
                          className="message-reasoning"
                          isStreaming={isLive && sending && !streamed}
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{message.reasoning}</ReasoningContent>
                        </Reasoning>
                      )}
                      <AnnotatedText
                        actionStatus={captureStatus(message.id)}
                        text={message.content}
                        annotations={message.annotations}
                        highlights={message.highlights}
                        onHighlight={
                          !isLive && !message.incomplete
                            ? (value) => saveHighlight(message.id, value)
                            : undefined
                        }
                        markdown
                        animatedAnnotationIds={
                          isLive
                            ? new Set(liveAnnotations.map((annotation) => annotation.id))
                            : message.id === recentAnimation?.messageId
                              ? recentAnimation.annotationIds
                              : undefined
                        }
                        onAction={(action, quote) =>
                          contextual(isLive ? null : message.id, action, quote)
                        }
                      />
                      <ResponseSources sources={message.sources} />
                      {!isLive && !message.incomplete && messageToolbar(message)}
                    </>
                  ) : (
                    <>
                      {editingMessageId === message.id ? (
                        <div className="user-message-editor">
                          <textarea
                            aria-label="Edit message"
                            rows={2}
                            value={editedMessage}
                            onChange={(event) => setEditedMessage(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                setEditingMessageId(null);
                                void send(editedMessage, 'message', message.id);
                              }
                            }}
                          />
                          <div className="user-message-editor-actions">
                            <button
                              type="button"
                              className="text-button"
                              aria-label="Cancel message edit"
                              onClick={() => {
                                setEditingMessageId(null);
                                setEditedMessage('');
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="primary user-message-save"
                              aria-label="Send edited message"
                              disabled={!editedMessage.trim()}
                              onClick={() => {
                                setEditingMessageId(null);
                                void send(editedMessage, 'message', message.id);
                              }}
                            >
                              Send
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p>{message.content}</p>
                      )}
                      {editingMessageId !== message.id &&
                        renderedMessages[index + 1]?.role === 'assistant' &&
                        renderedMessages[index + 1]?.incomplete &&
                        index + 1 === renderedMessages.length - 1 && (
                          <div className="message-toolbar user-message-toolbar">
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Edit message"
                              title="Edit message"
                              disabled={sending || input.length > 0}
                              onClick={() => {
                                setEditingMessageId(message.id);
                                setEditedMessage(message.content);
                              }}
                            >
                              <Pencil size={14} aria-hidden />
                            </button>
                          </div>
                        )}
                    </>
                  )}
                  {message.incomplete && (
                    <p className="action-notice__row action-notice__row--alert" role="alert">
                      <span className="action-notice__message">
                        {message.content.trim() ? 'Incomplete response' : 'No response received'}
                      </span>
                      {/* Retry lives on the failure itself. The response toolbar is
                          hidden for incomplete messages, so regenerate - the control
                          that does exactly this - was previously unreachable here. */}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Try again"
                        title="Try again"
                        disabled={sending}
                        onClick={() => retryIncomplete(message)}
                      >
                        <RefreshCw size={14} aria-hidden />
                      </button>
                    </p>
                  )}
                </article>
              </Fragment>
            );
          })}
          {sending && !streamed && !reasoning && (
            <div className="thinking" role="status" aria-live="polite" aria-atomic="true">
              <span />
              <span />
              <span /> {status}
            </div>
          )}
          {intervention && (
            <InterventionCard
              intervention={intervention}
              onResolve={(value) => {
                setIntervention(null);
                void send(value, 'feedback');
              }}
              onCapture={(value) => {
                if (!latestCompletedAssistantId) {
                  setError('Finish a response before adding this to your note.');
                  return;
                }
                void proposeNote(latestCompletedAssistantId, { text: value });
                setIntervention(null);
              }}
              onDismiss={() => setIntervention(null)}
            />
          )}
        </div>
      </div>
      {error && (
        <div className="chat-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss error"
            title="Dismiss error"
            onClick={() => setError('')}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={messageInput}
          aria-label="Message"
          rows={2}
          placeholder="Message…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="icon-button" aria-label="Chat tools">
                  <SlidersHorizontal size={16} aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-56 rounded-md border border-border bg-card p-1 text-foreground shadow-md"
                side="top"
                align="start"
              >
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm hover:bg-accent">
                  <span>Auto highlights</span>
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={autoHighlights}
                    aria-label="Auto highlights"
                    onChange={(event) => {
                      setAutoHighlights(event.target.checked);
                    }}
                  />
                </label>
              </PopoverContent>
            </Popover>
            <PersonaPicker
              personas={props.personas}
              value={effectivePersonaId}
              onChange={props.onPersona}
            />
            {checksSeen && (props.conversation?.learningChecksEnabled ?? true) && (
              <button
                type="button"
                className="learning-control"
                onClick={() => void send('Stop learning checks', 'stop_checks')}
              >
                Learning checks on
              </button>
            )}
          </div>
          <button
            className="send-button"
            type={sending ? 'button' : 'submit'}
            aria-label={sending ? 'Stop response' : 'Send message'}
            disabled={!sending && !input.trim()}
            onClick={sending ? stopMainTurn : undefined}
          >
            {sending ? <Square /> : <ArrowUp />}
          </button>
        </div>
      </form>
    </aside>
  );
}
