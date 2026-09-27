import type {
  LearningCheck,
  LearningCheckResponse,
  Message,
  MessageFollowupRequest,
} from '@walden/contracts';
import type { ReactNode } from 'react';

import {
  type ContextualActionId,
  contextualActionRequest,
} from '../../../highlights/contextual-actions';
import type { ChatPanelProps } from '../chat-panel-types';
import type { ChatPanelController } from '../hooks/controller/use-chat-panel-controller';
import { MessageToolbar } from './MessageToolbar';

type CaptureStatus = {
  pending: boolean;
  message?: string;
  alert?: boolean;
  onRetry?(): void;
  onDismiss?(): void;
} | null;

function learningCheckResponseText(check: LearningCheck, response: LearningCheckResponse) {
  return check.questions
    .map((question, index) => {
      const answer = response.answers[question.id]?.answers.join('; ') ?? 'Skipped';
      return check.questions.length === 1
        ? answer
        : `${index + 1}. ${question.question}\n${answer}`;
    })
    .join('\n\n');
}

function learningResponse(messages: Message[], index: number) {
  const check = messages[index].learningCheck;
  if (!check) return undefined;
  return messages
    .slice(index + 1)
    .find(
      (candidate) =>
        candidate.role === 'user' && candidate.learningCheckResponse?.checkId === check.id,
    )?.learningCheckResponse;
}

function answeredLearningCheck(messages: Message[], index: number) {
  const response = messages[index].learningCheckResponse;
  if (!response) return undefined;
  return [...messages.slice(0, index)]
    .reverse()
    .find((candidate) => candidate.learningCheck?.id === response.checkId)?.learningCheck;
}

function buildRenderedMessages(
  messages: Message[],
  regenerationIndex: number,
  streamCompletionId: string | null,
  optimisticMessage: Message | null,
  pendingEdit: { id: string; content: string } | null,
  liveResponse: Message | null,
) {
  const visible = regenerationIndex >= 0 ? messages.slice(0, regenerationIndex) : messages;
  const rendered = visible.filter(
    (message) => message.id !== streamCompletionId && message.id !== optimisticMessage?.id,
  );
  if (pendingEdit) {
    const editIndex = rendered.findIndex(({ id }) => id === pendingEdit.id);
    if (editIndex >= 0)
      rendered.splice(editIndex, rendered.length - editIndex, {
        ...rendered[editIndex],
        content: pendingEdit.content,
      });
  } else if (optimisticMessage) rendered.push(optimisticMessage);
  if (liveResponse) rendered.push(liveResponse);
  return rendered;
}

function captureStatus(controller: ChatPanelController, messageId: string): CaptureStatus {
  const pending = controller.proposalMessageId === messageId;
  const notice = controller.proposalNotices.get(messageId);
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
                  notice.onRetry
                    ? notice.onRetry()
                    : void controller.proposeNote(messageId, notice.capture),
              }
            : {}),
          onDismiss: () => controller.dismissProposalNotice(messageId),
        }
      : {}),
  };
}

function contextual(
  controller: ChatPanelController,
  messageId: string | null,
  action: ContextualActionId,
  quote: string,
) {
  if (action === 'capture') {
    if (!messageId) {
      controller.setError('Wait for the response to finish before adding it to your note.');
      return;
    }
    void controller.proposeNote(messageId, { text: quote });
    return;
  }
  const request = contextualActionRequest(action, quote);
  if (request) void controller.send(request.prompt, request.intent);
}

function highlightMessage(controller: ChatPanelController, messageId: string) {
  const conversationId = controller.activeConversationId.current;
  if (!conversationId || controller.annotationControllers.current.has(messageId)) return;
  const input: MessageFollowupRequest = {
    conversationId,
    branchId: controller.latestConversation.current?.branchId ?? '',
    personaId: controller.effectivePersonaId,
    noteRevision: null,
  };
  controller.retryAnnotations(messageId, input);
}

function messageToolbar(controller: ChatPanelController, message: Message) {
  const failure = controller.annotationFailures.get(message.id);
  const notice = controller.proposalNotices.get(message.id);
  return (
    <MessageToolbar
      sending={controller.sending}
      proposalPending={controller.proposalMessageId === message.id}
      highlighting={controller.backgroundAnnotations.has(message.id) || failure?.retrying === true}
      copied={controller.copiedMessageId === message.id}
      proposalNotice={
        notice?.capture
          ? undefined
          : notice
            ? {
                ...notice,
                ...(notice.retryable
                  ? {
                      onRetry: () =>
                        notice.onRetry
                          ? notice.onRetry()
                          : void controller.proposeNote(message.id, notice.capture),
                    }
                  : {}),
              }
            : undefined
      }
      highlightFailure={
        failure
          ? {
              message: failure.message,
              onRetry: () => controller.retryAnnotations(message.id, failure.input),
              onDismiss: () => controller.clearAnnotationFailure(message.id),
            }
          : undefined
      }
      onDismissNotice={() => controller.dismissProposalNotice(message.id)}
      onPropose={() => void controller.proposeNote(message.id)}
      onHighlight={() => highlightMessage(controller, message.id)}
      onRegenerate={() => void controller.regenerateResponse(message)}
      onCopy={() => void controller.copyMessage(message)}
    />
  );
}

export function useChatPanelViewModel(props: ChatPanelProps, controller: ChatPanelController) {
  const conversationMessages = props.conversation?.messages ?? [];
  const regenerationIndex = controller.regeneratingMessageId
    ? conversationMessages.findIndex(({ id }) => id === controller.regeneratingMessageId)
    : -1;
  const hasLiveResponse = Boolean(
    controller.streamed ||
      controller.reasoning ||
      controller.liveTools.length ||
      controller.liveSources.length ||
      controller.liveContextCompacted,
  );
  const liveResponseId = controller.activeRequestId.current ?? 'streaming-response';
  const liveResponse = hasLiveResponse
    ? {
        id: liveResponseId,
        role: 'assistant' as const,
        content: controller.streamed,
        reasoning: controller.reasoning,
        annotations: controller.liveAnnotations,
        tools: controller.liveTools,
        sources: controller.liveSources,
        contextCompacted: controller.liveContextCompacted,
        incomplete: controller.interrupted,
        createdAt: '',
      }
    : null;
  const renderedMessages = buildRenderedMessages(
    conversationMessages,
    regenerationIndex,
    controller.streamCompletionId.current,
    controller.optimisticMessage,
    controller.pendingEdit,
    liveResponse,
  );
  const latestCompletedAssistantId = [...conversationMessages]
    .reverse()
    .find((message) => message.role === 'assistant' && !message.incomplete)?.id;
  const hasConversationActivity =
    conversationMessages.length > 0 || Boolean(controller.optimisticMessage) || controller.sending;
  return {
    conversationMessages,
    hasConversationActivity,
    hasLiveResponse,
    liveResponseId,
    renderedMessages,
    latestCompletedAssistantId,
    captureStatus: (messageId: string) => captureStatus(controller, messageId),
    messageToolbar: (message: Message): ReactNode => messageToolbar(controller, message),
    contextual: (messageId: string | null, action: ContextualActionId, quote: string) =>
      contextual(controller, messageId, action, quote),
    highlightMessage: (messageId: string) => highlightMessage(controller, messageId),
    learningCheckResponseText,
    learningResponse,
    answeredLearningCheck,
  };
}

export type ChatPanelViewModel = ReturnType<typeof useChatPanelViewModel>;
