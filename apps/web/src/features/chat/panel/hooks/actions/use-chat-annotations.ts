import type { Annotation, MessageFollowupRequest, MessageHighlight } from '@walden/contracts';

import { api, streamMessageAnnotations } from '../../../../../lib/api';
import type { ChatPanelProps } from '../../chat-panel-types';
import { updateMessage, type WaldenChat, withMetadata } from '../session/turn-args';
import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatRuntimeState } from '../state/use-chat-runtime-state';

type AnnotationArgs = {
  props: ChatPanelProps;
  display: ChatDisplayState;
  runtime: ChatRuntimeState;
  chat: WaldenChat;
  effectivePersonaId: string;
  proposeNote(messageId: string, capture?: { text: string }): Promise<void>;
};

/** Saved messages first: the transcript snapshot in `args` can trail a just-finished reply. */
function annotationsOf(args: AnnotationArgs, messageId: string) {
  const find = (messages: typeof args.chat.messages = []) =>
    messages.find((message) => message.id === messageId);
  return (find(args.runtime.latestConversation.current?.messages) ?? find(args.chat.messages))
    ?.metadata?.annotations;
}

function animateAnnotations(args: AnnotationArgs, messageId: string, values: Annotation[]) {
  args.display.setRecentAnimation({
    messageId,
    annotationIds: new Set(values.map((annotation) => annotation.id)),
  });
  if (args.display.recentAnimationTimeout.current !== undefined)
    window.clearTimeout(args.display.recentAnimationTimeout.current);
  args.display.recentAnimationTimeout.current = window.setTimeout(() => {
    args.display.setRecentAnimation(null);
    args.display.recentAnimationTimeout.current = undefined;
  }, 600);
}

function mergeAnnotations(
  args: AnnotationArgs,
  messageId: string,
  values: Annotation[],
  animate = true,
) {
  const previousIds = new Set((annotationsOf(args, messageId) ?? []).map(({ id }) => id));
  const arrivals = values.filter((annotation) => !previousIds.has(annotation.id));
  void updateMessage(args, messageId, (message) => withMetadata(message, { annotations: values }));
  if (animate && arrivals.length) animateAnnotations(args, messageId, arrivals);
}

function mergeAnnotationBatch(current: Annotation[], next: Annotation[]) {
  const seen = new Set(current.map((annotation) => annotation.id));
  return [...current, ...next.filter((annotation) => !seen.has(annotation.id))];
}

async function saveHighlight(args: AnnotationArgs, messageId: string, value: MessageHighlight) {
  const scope = args.runtime.latestConversation.current;
  if (!scope) return;
  const saved = await api.saveHighlight(messageId, value);
  const current = args.runtime.latestConversation.current;
  if (!current || current.id !== scope.id || current.branchId !== scope.branchId) return;
  await updateMessage(args, messageId, (message) =>
    withMetadata(message, {
      highlights: [
        ...(message.metadata?.highlights ?? []).filter(
          (item) => item.start !== saved.start || item.end !== saved.end,
        ),
        saved,
      ],
    }),
  );
}

function clearAnnotationFailure(display: ChatDisplayState, messageId: string) {
  display.setAnnotationFailures((current) => {
    if (!current.has(messageId)) return current;
    const next = new Map(current);
    next.delete(messageId);
    return next;
  });
}

export function resetAnnotationRetries(display: ChatDisplayState) {
  display.setAnnotationFailures((current) => {
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

function annotationIsCurrent(
  args: AnnotationArgs,
  messageId: string,
  controller: AbortController,
  conversationId: string | null,
) {
  return (
    !controller.signal.aborted &&
    args.runtime.annotationControllers.current.get(messageId) === controller &&
    args.runtime.activeConversationId.current === conversationId
  );
}

async function runAnnotationStream(
  args: AnnotationArgs,
  messageId: string,
  input: MessageFollowupRequest,
  controller: AbortController,
  conversationId: string | null,
) {
  const baseline = annotationsOf(args, messageId) ?? [];
  let partial = baseline;
  try {
    await streamMessageAnnotations(
      messageId,
      input,
      (event) => {
        if (!annotationIsCurrent(args, messageId, controller, conversationId)) return;
        if (event.type === 'annotation') {
          if (partial.some((annotation) => annotation.id === event.annotation.id)) return;
          partial = [...partial, event.annotation];
          mergeAnnotations(args, messageId, partial);
        } else if (event.type === 'done') {
          partial = mergeAnnotationBatch(partial, event.annotations);
          mergeAnnotations(args, messageId, partial);
          clearAnnotationFailure(args.display, messageId);
        }
      },
      controller.signal,
    );
  } catch (error) {
    if (annotationIsCurrent(args, messageId, controller, conversationId))
      mergeAnnotations(args, messageId, baseline, false);
    throw error;
  }
}

function reportAnnotationFailure(
  args: AnnotationArgs,
  messageId: string,
  input: MessageFollowupRequest,
  error: unknown,
) {
  args.display.setAnnotationFailures((current) =>
    new Map(current).set(messageId, {
      input,
      retrying: false,
      message:
        error instanceof Error
          ? error.message
          : 'Highlights could not be generated. Please try again.',
    }),
  );
}

function retryAnnotations(args: AnnotationArgs, messageId: string, input: MessageFollowupRequest) {
  args.runtime.annotationControllers.current.get(messageId)?.abort();
  const controller = new AbortController();
  const conversationId = args.runtime.activeConversationId.current;
  args.runtime.annotationControllers.current.set(messageId, controller);
  args.display.setAnnotationFailures((current) =>
    new Map(current).set(messageId, { input, retrying: true }),
  );
  void runAnnotationStream(args, messageId, input, controller, conversationId)
    .catch((error) => {
      if (!annotationIsCurrent(args, messageId, controller, conversationId)) return;
      reportAnnotationFailure(args, messageId, input, error);
    })
    .finally(() => {
      if (args.runtime.annotationControllers.current.get(messageId) === controller)
        args.runtime.annotationControllers.current.delete(messageId);
    });
}

function startAutomaticAnnotations(
  args: AnnotationArgs,
  messageId: string,
  input: MessageFollowupRequest,
  conversationId: string,
) {
  const controller = new AbortController();
  args.runtime.annotationControllers.current.set(messageId, controller);
  args.display.setBackgroundAnnotations((current) => new Set(current).add(messageId));
  void runAnnotationStream(args, messageId, input, controller, conversationId)
    .catch((error) => {
      if (!annotationIsCurrent(args, messageId, controller, conversationId)) return;
      reportAnnotationFailure(args, messageId, input, error);
    })
    .finally(() => {
      args.display.setBackgroundAnnotations((current) => {
        if (!current.has(messageId)) return current;
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
      if (args.runtime.annotationControllers.current.get(messageId) === controller)
        args.runtime.annotationControllers.current.delete(messageId);
    });
}

function launchFollowups(
  args: AnnotationArgs,
  messageId: string,
  conversationId: string,
  noteRevision: number | null,
  annotationsHandled = false,
) {
  const input = {
    conversationId,
    branchId: args.runtime.latestConversation.current?.branchId ?? '',
    personaId: args.effectivePersonaId,
    noteRevision,
  };
  if (args.display.autoHighlights && !annotationsHandled)
    startAutomaticAnnotations(args, messageId, input, conversationId);
  const record = args.runtime.pendingRecord.current;
  args.runtime.pendingRecord.current = null;
  if (record) void args.proposeNote(messageId, { text: record });
}

export function useChatAnnotations(args: AnnotationArgs) {
  return {
    animateAnnotations: (messageId: string, values: Annotation[]) =>
      animateAnnotations(args, messageId, values),
    saveHighlight: (messageId: string, value: MessageHighlight) =>
      saveHighlight(args, messageId, value),
    clearAnnotationFailure: (messageId: string) => clearAnnotationFailure(args.display, messageId),
    resetAnnotationRetries: () => resetAnnotationRetries(args.display),
    retryAnnotations: (messageId: string, input: MessageFollowupRequest) =>
      retryAnnotations(args, messageId, input),
    launchFollowups: (
      messageId: string,
      conversationId: string,
      noteRevision: number | null,
      annotationsHandled?: boolean,
    ) => launchFollowups(args, messageId, conversationId, noteRevision, annotationsHandled),
  };
}
