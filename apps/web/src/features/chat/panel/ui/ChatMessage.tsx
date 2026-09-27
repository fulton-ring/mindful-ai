import type {
  Annotation,
  LearningCheck,
  LearningCheckResponse,
  Message,
  MessageHighlight,
} from '@walden/contracts';
import { Pencil, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import { Attachments } from '../../../../components/ai-elements/attachments';
import { math } from '../../../../components/ai-elements/math';

import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '../../../../components/ai-elements/reasoning';
import { InterventionCard } from '../../../capture/InterventionCard';
import { AnnotatedText } from '../../../highlights/AnnotatedText';
import type { ContextualActionId } from '../../../highlights/contextual-actions';
import { ContextCheckpoint } from '../../ContextCheckpoint';
import { ResponseActivity, ResponseSources } from '../../ResponseActivity';
import { AttachmentBadge } from './AttachmentBadge';

type ActionStatus = {
  pending: boolean;
  message?: string;
  alert?: boolean;
  onRetry?(): void;
  onDismiss?(): void;
} | null;

type Props = {
  conversationId?: string;
  message: Message;
  index: number;
  messages: Message[];
  isLive: boolean;
  selectedPersonaName?: string;
  sending: boolean;
  streamed: string;
  visible: boolean;
  learningCheckResponse?: LearningCheckResponse;
  answeredCheck?: LearningCheck;
  editing: boolean;
  editedMessage: string;
  input: string;
  liveAnnotations: Annotation[];
  toolbar: ReactNode;
  messageAnimation(messageId: string): ReadonlySet<string> | undefined;
  captureStatus: ActionStatus;
  onLearningCheck(value: LearningCheckResponse): void;
  onDismissLearningCheck(): void;
  onHighlight(value: MessageHighlight): Promise<void>;
  onAction(action: ContextualActionId, quote: string): void;
  onEdit(): void;
  onEditedMessage(value: string): void;
  onCancelEdit(): void;
  onSendEdit(): void;
  onRetry(): void;
};

export function ChatMessage({ message, ...props }: Props) {
  return (
    <>
      {message.role === 'assistant' && message.contextCompacted && <ContextCheckpoint />}
      <article className={`message ${message.role}`}>
        {message.role === 'assistant' ? (
          <AssistantMessage message={message} {...props} />
        ) : (
          <UserMessage message={message} {...props} />
        )}
        {message.incomplete && (
          <IncompleteNotice message={message} sending={props.sending} onRetry={props.onRetry} />
        )}
      </article>
    </>
  );
}

function AssistantMessage({ message, ...props }: Omit<Props, 'message'> & { message: Message }) {
  return (
    <>
      <p className="message-sender">
        {message.personaName ?? props.selectedPersonaName ?? 'Assistant'}
      </p>
      <ResponseActivity
        tools={message.tools}
        sources={message.sources}
        live={props.isLive && props.sending}
      />
      {message.reasoning && (
        <Reasoning
          className="message-reasoning"
          isStreaming={props.isLive && props.sending && !props.streamed}
        >
          <ReasoningTrigger />
          <ReasoningContent>{message.reasoning}</ReasoningContent>
        </Reasoning>
      )}
      {message.learningCheck ? (
        <LearningCheckMessage
          message={message}
          response={props.learningCheckResponse}
          onResolve={props.onLearningCheck}
          onDismiss={props.onDismissLearningCheck}
        />
      ) : (
        <AnnotatedText
          active={props.visible}
          actionStatus={props.captureStatus}
          text={message.content}
          annotations={message.annotations}
          highlights={message.highlights}
          onHighlight={!props.isLive && !message.incomplete ? props.onHighlight : undefined}
          markdown
          animatedAnnotationIds={
            props.isLive
              ? new Set(props.liveAnnotations.map((item) => item.id))
              : props.messageAnimation(message.id)
          }
          onAction={props.onAction}
        />
      )}
      <ResponseSources sources={message.sources} />
      {props.toolbar}
    </>
  );
}

function LearningCheckMessage({
  message,
  response,
  onResolve,
  onDismiss,
}: {
  message: Message;
  response?: LearningCheckResponse;
  onResolve(value: LearningCheckResponse): void;
  onDismiss(): void;
}) {
  return (
    <InterventionCard
      intervention={message.learningCheck!}
      resolved={response}
      onResolve={(value) => {
        if (typeof value !== 'string') onResolve(value);
      }}
      onCapture={() => undefined}
      onDismiss={onDismiss}
    />
  );
}

function UserMessage({ message, ...props }: Omit<Props, 'message'> & { message: Message }) {
  return (
    <>
      {message.learningCheckResponse && props.answeredCheck ? (
        <div className="learning-check-response">
          <p className="eyebrow">My answers</p>
          {props.answeredCheck.questions.map((question) => (
            <div key={question.id}>
              <span>{question.header}</span>
              <p>
                {message.learningCheckResponse?.answers[question.id]?.answers.join('; ') ??
                  'Skipped'}
              </p>
            </div>
          ))}
        </div>
      ) : props.editing ? (
        <EditMessage {...props} />
      ) : (
        <div className="user-message-content">
          <Streamdown skipHtml plugins={{ math }}>
            {message.content}
          </Streamdown>
        </div>
      )}
      {message.attachments?.length && props.conversationId ? (
        <Attachments variant="inline" className="message-attachments">
          {message.attachments.map((file) => (
            <AttachmentBadge
              key={file.id}
              file={{ ...file, conversationId: props.conversationId! }}
            />
          ))}
        </Attachments>
      ) : null}
      {!message.learningCheckResponse &&
        !props.editing &&
        props.messages[props.index + 1]?.incomplete &&
        props.index + 1 === props.messages.length - 1 && (
          <div className="message-toolbar user-message-toolbar">
            <button
              type="button"
              className="icon-button"
              aria-label="Edit message"
              title="Edit message"
              disabled={props.sending || props.input.length > 0}
              onClick={props.onEdit}
            >
              <Pencil size={14} aria-hidden />
            </button>
          </div>
        )}
    </>
  );
}

function EditMessage(props: Omit<Props, 'message'>) {
  return (
    <div className="user-message-editor">
      <textarea
        aria-label="Edit message"
        rows={2}
        value={props.editedMessage}
        onChange={(event) => props.onEditedMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            props.onSendEdit();
          }
        }}
      />
      <div className="user-message-editor-actions">
        <button
          type="button"
          className="text-button"
          aria-label="Cancel message edit"
          onClick={props.onCancelEdit}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary user-message-save"
          aria-label="Send edited message"
          disabled={!props.editedMessage.trim()}
          onClick={props.onSendEdit}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function IncompleteNotice({
  message,
  sending,
  onRetry,
}: {
  message: Message;
  sending: boolean;
  onRetry(): void;
}) {
  return (
    <p className="action-notice__row action-notice__row--alert" role="alert">
      <span className="action-notice__message">
        {message.content.trim() ? 'Incomplete response' : 'No response received'}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Try again"
        title="Try again"
        disabled={sending}
        onClick={onRetry}
      >
        <RefreshCw size={14} aria-hidden />
      </button>
    </p>
  );
}
