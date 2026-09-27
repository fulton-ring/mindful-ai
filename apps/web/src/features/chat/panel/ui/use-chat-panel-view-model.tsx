import type {
  LearningCheck,
  LearningCheckResponse,
  MessageFollowupRequest,
  WaldenUIMessage,
} from '@walden/contracts';
import type { ReactNode } from 'react';

import {
  type ContextualActionId,
  contextualActionRequest,
} from '../../../highlights/contextual-actions';
import {
  isInterrupted,
  learningCheckOf,
  learningCheckResponseOf,
  messageText,
  reasoningText,
} from '../../message-parts';
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

function learningResponse(messages: WaldenUIMessage[], index: number) {
  const check = learningCheckOf(messages[index]!);
  if (!check) return undefined;
  for (const candidate of messages.slice(index + 1)) {
    const response = candidate.role === 'user' ? learningCheckResponseOf(candidate) : undefined;
    if (response?.checkId === check.id) return response;
  }
  return undefined;
}

function answeredLearningCheck(messages: WaldenUIMessage[], index: number) {
  const response = learningCheckResponseOf(messages[index]!);
  if (!response) return undefined;
  return messages
    .slice(0, index)
    .reverse()
    .map(learningCheckOf)
    .find((check) => check?.id === response.checkId);
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

function messageToolbar(controller: ChatPanelController, message: WaldenUIMessage) {
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

export function useChatPanelViewModel(controller: ChatPanelController) {
  const messages = controller.messages;
  const last = messages.at(-1);
  const liveResponseId = controller.sending && last?.role === 'assistant' ? last.id : null;
  const liveResponse = liveResponseId ? last : undefined;
  const latestCompletedAssistantId = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' && !isInterrupted(message) && message.id !== liveResponseId,
    )?.id;
  return {
    renderedMessages: messages,
    hasConversationActivity: messages.length > 0 || controller.sending,
    liveResponseId,
    /** The indicator stays until the live reply has something to read. */
    thinking:
      controller.sending &&
      !(liveResponse && (messageText(liveResponse) || reasoningText(liveResponse))),
    latestCompletedAssistantId,
    captureStatus: (messageId: string) => captureStatus(controller, messageId),
    messageToolbar: (message: WaldenUIMessage): ReactNode => messageToolbar(controller, message),
    contextual: (messageId: string | null, action: ContextualActionId, quote: string) =>
      contextual(controller, messageId, action, quote),
    highlightMessage: (messageId: string) => highlightMessage(controller, messageId),
    learningCheckResponseText,
    learningResponse,
    answeredLearningCheck,
  };
}

export type ChatPanelViewModel = ReturnType<typeof useChatPanelViewModel>;
