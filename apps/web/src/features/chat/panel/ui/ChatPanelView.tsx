import { FileText, X } from 'lucide-react';

import { BranchSelector } from '../../BranchSelector';
import { isInterrupted, learningCheckOf, messageText } from '../../message-parts';
import type { ChatPanelProps } from '../chat-panel-types';
import type { ChatPanelController } from '../hooks/controller/use-chat-panel-controller';
import { ChatComposer } from './ChatComposer';
import { ChatMessage } from './ChatMessage';
import { ChatTranscript } from './ChatTranscript';
import type { ChatPanelViewModel } from './use-chat-panel-view-model';

type ViewProps = {
  props: ChatPanelProps;
  controller: ChatPanelController;
  model: ChatPanelViewModel;
};

function OpenNoteButton({ onOpenNote }: { onOpenNote(): void }) {
  return (
    <button
      type="button"
      className="open-note-button inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm"
      onClick={onOpenNote}
    >
      <FileText size={16} aria-hidden /> Open note
    </button>
  );
}

function ThinkingIndicator({ status }: { status: string }) {
  return (
    <div className="thinking" role="status" aria-live="polite" aria-atomic="true">
      <span />
      <span />
      <span /> {status}
    </div>
  );
}

function ErrorNotice({ message, onDismiss }: { message: string; onDismiss(): void }) {
  return (
    <div className="chat-error" role="alert">
      <p>{message}</p>
      {/reload/i.test(message) && <button onClick={() => location.reload()}>Reload Walden</button>}
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss error"
        title="Dismiss error"
        onClick={onDismiss}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

function TranscriptMessage({
  props,
  controller,
  model,
  message,
  index,
}: ViewProps & { message: ChatPanelViewModel['renderedMessages'][number]; index: number }) {
  const isLive = message.id === model.liveResponseId;
  const learningCheck = learningCheckOf(message);
  return (
    <ChatMessage
      message={message}
      index={index}
      messages={model.renderedMessages}
      isLive={isLive}
      selectedPersonaName={controller.selectedPersona?.name}
      sending={controller.sending}
      visible={props.visible !== false}
      learningCheckResponse={model.learningResponse(model.renderedMessages, index)}
      answeredCheck={model.answeredLearningCheck(model.renderedMessages, index)}
      editing={controller.editingMessageId === message.id}
      editedMessage={controller.editedMessage}
      input={controller.input}
      toolbar={
        !isLive && !isInterrupted(message) && !learningCheck ? model.messageToolbar(message) : null
      }
      captureStatus={model.captureStatus(message.id)}
      messageAnimation={(messageId) =>
        messageId === controller.recentAnimation?.messageId
          ? controller.recentAnimation.annotationIds
          : undefined
      }
      onLearningCheck={(value) =>
        void controller.send(
          model.learningCheckResponseText(learningCheck!, value),
          'feedback',
          undefined,
          value,
        )
      }
      onDismissLearningCheck={() =>
        void controller.send('Skip this learning check.', 'feedback', undefined, {
          checkId: learningCheck!.id,
          answers: {},
        })
      }
      onHighlight={(value) => controller.saveHighlight(message.id, value)}
      onAction={(action, quote) => model.contextual(isLive ? null : message.id, action, quote)}
      onEdit={() => {
        controller.setEditingMessageId(message.id);
        controller.setEditedMessage(messageText(message));
      }}
      onEditedMessage={controller.setEditedMessage}
      onCancelEdit={() => {
        controller.setEditingMessageId(null);
        controller.setEditedMessage('');
      }}
      onSendEdit={() => {
        controller.setEditingMessageId(null);
        void controller.send(controller.editedMessage, 'message', message.id);
      }}
      onRetry={() => controller.retryIncomplete(message)}
    />
  );
}

function TranscriptArea({ props, controller, model }: ViewProps) {
  return (
    <div
      ref={controller.scroller}
      className={`chat-scroll ${model.hasConversationActivity ? '' : 'is-empty'}`}
      aria-live="polite"
      onWheel={(event) => {
        if (event.deltaY < 0) controller.followingResponse.current = false;
      }}
      onScroll={(event) => {
        const panel = event.currentTarget;
        controller.followingResponse.current =
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
        {!model.hasConversationActivity && (
          <div className="chat-empty">
            <h2>What’s on your mind?</h2>
          </div>
        )}
        <ChatTranscript
          messages={model.renderedMessages}
          renderMessage={(message, index) => (
            <TranscriptMessage
              props={props}
              controller={controller}
              model={model}
              message={message}
              index={index}
            />
          )}
        />
        {model.thinking && <ThinkingIndicator status={controller.status} />}
      </div>
    </div>
  );
}

export function ChatPanelView({ props, controller, model }: ViewProps) {
  return (
    <aside
      className={`chat-panel ${model.hasConversationActivity ? '' : 'empty-conversation'}`}
      aria-label="Thread"
    >
      {!props.noteOpen && <OpenNoteButton onOpenNote={props.onOpenNote} />}
      <TranscriptArea props={props} controller={controller} model={model} />
      {controller.error && (
        <ErrorNotice message={controller.error} onDismiss={() => controller.setError('')} />
      )}
      <ChatComposer
        input={controller.input}
        attachments={controller.attachments}
        uploadProgress={controller.progress}
        onAttach={controller.addAttachments}
        onRemoveAttachment={(index) => {
          const file = controller.attachments[index];
          if (file) controller.removeAttachment(file);
        }}
        sending={controller.sending}
        savingChatPreference={controller.savingChatPreference}
        webSearch={props.conversation?.webSearchEnabled ?? true}
        learningChecks={props.conversation?.learningChecksEnabled ?? true}
        autoHighlights={controller.autoHighlights}
        personas={props.personas}
        personaId={controller.effectivePersonaId}
        budget={props.budget}
        messageInput={controller.messageInput}
        onInput={controller.setInput}
        onSend={() => void controller.send()}
        onStop={controller.stopMainTurn}
        onPersona={props.onPersona}
        onPreference={(setting, enabled) => void controller.changeChatPreference(setting, enabled)}
        onAutoHighlights={controller.setAutoHighlights}
      />
    </aside>
  );
}
