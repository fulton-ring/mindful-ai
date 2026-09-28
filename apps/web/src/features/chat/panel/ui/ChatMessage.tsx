import type {
  LearningCheck,
  LearningCheckResponse,
  MessageHighlight,
  WaldenUIMessage,
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
import { useSmoothText } from '../../../highlights/use-smooth-text';
import { ContextCheckpoint } from '../../ContextCheckpoint';
import {
  filePartsOf,
  isInterrupted,
  learningCheckOf,
  learningCheckResponseOf,
  messageText,
  reasoningText,
} from '../../message-parts';
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
  message: WaldenUIMessage;
  index: number;
  messages: WaldenUIMessage[];
  isLive: boolean;
  selectedPersonaName?: string;
  sending: boolean;
  visible: boolean;
  learningCheckResponse?: LearningCheckResponse;
  answeredCheck?: LearningCheck;
  editing: boolean;
  editedMessage: string;
  input: string;
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
      {message.role === 'assistant' && message.metadata?.contextCompacted && <ContextCheckpoint />}
      <article className={`message ${message.role}`}>
        {message.role === 'assistant' ? (
          <AssistantMessage message={message} {...props} />
        ) : (
          <UserMessage message={message} {...props} />
        )}
        {isInterrupted(message) && (
          <IncompleteNotice message={message} sending={props.sending} onRetry={props.onRetry} />
        )}
      </article>
    </>
  );
}

type MessageProps = Omit<Props, 'message'> & { message: WaldenUIMessage };

function AssistantMessage({ message, ...props }: MessageProps) {
  const streaming = props.isLive && props.sending;
  const { text, revealing } = useSmoothText(messageText(message), streaming);
  const reasoning = reasoningText(message);
  const learningCheck = learningCheckOf(message);
  const interrupted = isInterrupted(message);
  const annotations = message.metadata?.annotations;
  return (
    <>
      <p className="message-sender">
        {message.metadata?.personaName ?? props.selectedPersonaName ?? 'Assistant'}
      </p>
      <ResponseActivity
        parts={message.parts}
        live={props.isLive && props.sending}
        interrupted={interrupted}
      />
      {reasoning && (
        <Reasoning
          className="message-reasoning"
          isStreaming={props.isLive && props.sending && !text}
        >
          <ReasoningTrigger />
          <ReasoningContent>{reasoning}</ReasoningContent>
        </Reasoning>
      )}
      {learningCheck ? (
        <LearningCheckMessage
          check={learningCheck}
          response={props.learningCheckResponse}
          onResolve={props.onLearningCheck}
          onDismiss={props.onDismissLearningCheck}
        />
      ) : (
        <AnnotatedText
          active={props.visible}
          actionStatus={props.captureStatus}
          text={text}
          annotations={annotations}
          highlights={message.metadata?.highlights}
          onHighlight={!props.isLive && !interrupted ? props.onHighlight : undefined}
          markdown
          streaming={revealing}
          animatedAnnotationIds={
            props.isLive
              ? new Set((annotations ?? []).map((item) => item.id))
              : props.messageAnimation(message.id)
          }
          onAction={props.onAction}
        />
      )}
      <ResponseSources parts={message.parts} />
      {props.toolbar}
    </>
  );
}

function LearningCheckMessage({
  check,
  response,
  onResolve,
  onDismiss,
}: {
  check: LearningCheck;
  response?: LearningCheckResponse;
  onResolve(value: LearningCheckResponse): void;
  onDismiss(): void;
}) {
  return (
    <InterventionCard
      intervention={check}
      resolved={response}
      onResolve={(value) => {
        if (typeof value !== 'string') onResolve(value);
      }}
      onCapture={() => undefined}
      onDismiss={onDismiss}
    />
  );
}

function UserMessage({ message, ...props }: MessageProps) {
  const response = learningCheckResponseOf(message);
  const files = filePartsOf(message);
  const next = props.messages[props.index + 1];
  return (
    <>
      {response && props.answeredCheck ? (
        <div className="learning-check-response">
          <p className="eyebrow">My answers</p>
          {props.answeredCheck.questions.map((question) => (
            <div key={question.id}>
              <span>{question.header}</span>
              <p>{response.answers[question.id]?.answers.join('; ') ?? 'Skipped'}</p>
            </div>
          ))}
        </div>
      ) : props.editing ? (
        <EditMessage {...props} />
      ) : (
        <div className="user-message-content">
          <Streamdown skipHtml plugins={{ math }}>
            {messageText(message)}
          </Streamdown>
        </div>
      )}
      {files.length ? (
        <Attachments variant="inline" className="message-attachments">
          {files.map((file) => (
            <AttachmentBadge key={file.url} file={file} />
          ))}
        </Attachments>
      ) : null}
      {!response &&
        !props.editing &&
        next &&
        isInterrupted(next) &&
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
  message: WaldenUIMessage;
  sending: boolean;
  onRetry(): void;
}) {
  return (
    <p className="action-notice__row action-notice__row--alert" role="alert">
      <span className="action-notice__message">
        {messageText(message).trim() ? 'Incomplete response' : 'No response received'}
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
