import type { MessageBudget } from '@walden/contracts';
import { ArrowUp, Square } from 'lucide-react';
import type { ComponentProps, DragEvent, RefObject } from 'react';
import { useRef, useState } from 'react';
import { Attachments } from '../../../../components/ai-elements/attachments';
import { inferenceConfig, runtimeConfig, useRuntimeConfig } from '../../../../lib/runtime-config';
import { fileAnalytics, track } from '../../../../lib/telemetry';

import { effectivePersona, PersonaPicker } from '../../../personas/PersonaPicker';
import { AttachmentBadge } from './AttachmentBadge';
import { ChatToolsMenu } from './ChatToolsMenu';
import { ComposerEditor } from './ComposerEditor';
import { messageLimitNotice } from './message-limit-notice';

const FILE_ACCEPT =
  '.md,.markdown,.txt,.csv,.json,.ts,.tsx,.js,.jsx,.py,.sql,.html,.css,.xml,.yaml,.yml,.toml,.sh,.log,.pdf,.docx,.xlsx,image/png,image/jpeg,image/webp';
const acceptedFileTypes = FILE_ACCEPT.split(',');
const documentExtensions = ['.pdf', '.docx', '.xlsx'];
function documentFilesUnavailable() {
  return runtimeConfig()?.capabilities?.documentExtraction === false;
}
function fileAccept() {
  return documentFilesUnavailable()
    ? acceptedFileTypes.filter((type) => !documentExtensions.includes(type)).join(',')
    : FILE_ACCEPT;
}
const BLOCK_HELP: Record<string, string> = {
  inference_unavailable:
    'AI replies are unavailable. Check the selected persona and server configuration.',
  preference_saving: 'Wait for chat settings to save.',
  upload_in_progress: 'Wait for the upload to finish.',
  message_too_long: 'Messages are limited to 2,000 characters.',
  empty_message: 'Enter a message or attach a file.',
  message_limit: 'You have reached your message limit.',
};

function acceptsFile(file: File) {
  const name = file.name.toLowerCase();
  return acceptedFileTypes.some((type) =>
    type.startsWith('.') ? name.endsWith(type) : file.type === type,
  );
}

function fileError(files: File[], currentCount: number): { message: string; code: string } | null {
  if (
    documentFilesUnavailable() &&
    files.some((file) => documentExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)))
  )
    return {
      message:
        'Document attachments are not configured on this instance. Attach a supported text file or image.',
      code: 'document_extraction_unavailable',
    };
  if (currentCount + files.length > 5)
    return { message: 'Choose up to five files.', code: 'too_many_files' };
  if (files.some((file) => file.size > 1_000_000 || file.size === 0))
    return { message: 'Each file must be under 1 MB.', code: 'file_size' };
  if (files.some((file) => !acceptsFile(file)))
    return {
      message: 'Only supported text, document, and image files can be attached.',
      code: 'unsupported_file',
    };
  return null;
}

type ComposerProps = {
  input: string;
  sending: boolean;
  savingChatPreference: boolean;
  webSearch: boolean;
  learningChecks: boolean;
  autoHighlights: boolean;
  personas: ComponentProps<typeof PersonaPicker>['personas'];
  personaId: string;
  budget?: MessageBudget | null;
  messageInput: RefObject<HTMLElement | null>;
  attachments?: File[];
  uploadProgress?: ReadonlyMap<File, number>;
  onAttach?(files: File[]): void;
  onRemoveAttachment?(index: number): void;
  onInput(value: string): void;
  onSend(): void;
  onStop(): void;
  onPersona(id: string): void;
  onPreference(setting: 'learningChecks' | 'webSearch', enabled: boolean): void;
  onAutoHighlights(enabled: boolean): void;
};

function AttachmentChips({
  files,
  progress,
  disabled,
  onRemove,
}: {
  files: File[];
  progress?: ReadonlyMap<File, number>;
  disabled: boolean;
  onRemove(index: number): void;
}) {
  if (!files.length) return null;
  return (
    <Attachments variant="inline" className="composer-attachments">
      {files.map((file, index) => (
        <div className="composer-upload" key={`${file.name}-${index}`}>
          <AttachmentBadge
            file={file}
            disabled={disabled}
            onRemove={disabled ? undefined : () => onRemove(index)}
          />
          {(progress ? (progress.get(file) ?? 0) < 100 : false) && (
            <progress
              aria-label={`Uploading ${file.name}`}
              max={100}
              value={progress?.get(file) ?? 0}
            />
          )}
        </div>
      ))}
    </Attachments>
  );
}

function SendButton({
  sending,
  blockedReason,
  onSend,
  onStop,
}: {
  sending: boolean;
  blockedReason: string | null;
  onSend(): void;
  onStop(): void;
}) {
  return (
    <button
      className="send-button"
      type="button"
      aria-label={sending ? 'Stop response' : 'Send message'}
      aria-disabled={Boolean(blockedReason)}
      title={blockedReason ? BLOCK_HELP[blockedReason] : undefined}
      onClick={() => {
        if (blockedReason)
          track('action_blocked', { action: 'send_message', failure_code: blockedReason });
        else if (sending) onStop();
        else onSend();
      }}
    >
      {sending ? <Square /> : <ArrowUp />}
    </button>
  );
}

function useFileDrop(onFiles: (files: File[]) => void, disabled: boolean) {
  const depth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  return {
    draggingFiles,
    dropHandlers: {
      onDragEnter(event: DragEvent<HTMLFormElement>) {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        depth.current += 1;
        setDraggingFiles(true);
      },
      onDragOver(event: DragEvent<HTMLFormElement>) {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave() {
        if (!depth.current) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDraggingFiles(false);
      },
      onDrop(event: DragEvent<HTMLFormElement>) {
        depth.current = 0;
        setDraggingFiles(false);
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (!disabled) onFiles([...event.dataTransfer.files]);
      },
    },
  };
}

function useComposerFiles(attachments: File[], onAttach: (files: File[]) => void) {
  const [error, setError] = useState('');
  const addFiles = (files: File[]) => {
    const next = fileError(files, attachments.length);
    if (next) {
      track('file_upload_blocked', {
        failure_code: next.code,
        attachment_count: files.length,
        ...(files.length === 1 && files[0] ? fileAnalytics(files[0]) : {}),
      });
      return setError(next.message);
    }
    setError('');
    onAttach(files);
  };
  return { error, addFiles };
}

function sendBlockReason(
  sending: boolean,
  savingPreference: boolean,
  input: string,
  attachments: File[],
  progress?: ReadonlyMap<File, number>,
): string | null {
  if (sending) return null;
  if (savingPreference) return 'preference_saving';
  if (progress && attachments.some((file) => (progress.get(file) ?? 0) < 100))
    return 'upload_in_progress';
  if (input.length > 2000) return 'message_too_long';
  if (!input.trim() && attachments.length === 0) return 'empty_message';
  return null;
}

function attemptSend(blockedReason: string | null, onSend: () => void) {
  if (blockedReason)
    track('action_blocked', { action: 'send_message', failure_code: blockedReason });
  else onSend();
}

export function ChatComposer({
  input,
  sending,
  savingChatPreference,
  webSearch,
  learningChecks,
  autoHighlights,
  personas,
  personaId,
  budget,
  messageInput,
  attachments = [],
  uploadProgress,
  onAttach = () => undefined,
  onRemoveAttachment = () => undefined,
  onInput,
  onSend,
  onStop,
  onPersona,
  onPreference,
  onAutoHighlights,
}: ComposerProps) {
  useRuntimeConfig();
  const selectedPersona = effectivePersona(personas, personaId);
  const inferenceNotice = modelNotice(selectedPersona?.model);
  const fileInput = useRef<HTMLInputElement>(null);
  const { error: attachmentError, addFiles } = useComposerFiles(attachments, onAttach);
  const { draggingFiles, dropHandlers } = useFileDrop(addFiles, sending);
  const limitNotice = messageLimitNotice(budget, selectedPersona, sending);
  const blocked = inferenceNotice
    ? 'inference_unavailable'
    : limitNotice
      ? 'message_limit'
      : sendBlockReason(sending, savingChatPreference, input, attachments, uploadProgress);
  const sendIfReady = () => attemptSend(blocked, onSend);

  return (
    <form
      className={`composer${draggingFiles ? ' composer-dragging' : ''}`}
      {...dropHandlers}
      onSubmit={(event) => {
        event.preventDefault();
        sendIfReady();
      }}
    >
      <ComposerNotices notices={[inferenceNotice, limitNotice]} />
      <ComposerEditor
        value={input}
        disabled={sending || Boolean(limitNotice)}
        inputRef={messageInput}
        onChange={onInput}
        onSend={sendIfReady}
        onPasteFiles={addFiles}
      />
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        multiple
        accept={fileAccept()}
        aria-label="Choose files"
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <AttachmentChips
        files={attachments}
        progress={uploadProgress}
        disabled={sending}
        onRemove={onRemoveAttachment}
      />
      {attachmentError && (
        <p className="composer-error" role="alert">
          {attachmentError}
        </p>
      )}
      {input.length > 1800 && <span className="composer-count">{input.length}/2000</span>}
      <div className="composer-footer">
        <div className="composer-tools">
          <ChatToolsMenu
            webSearch={webSearch}
            learningChecks={learningChecks}
            autoHighlights={autoHighlights}
            disabled={sending || savingChatPreference}
            onAddFiles={() => fileInput.current?.click()}
            onPreference={onPreference}
            onAutoHighlights={onAutoHighlights}
          />
          <PersonaPicker
            personas={personas}
            value={selectedPersona?.id ?? personaId}
            onChange={onPersona}
          />
        </div>
        <SendButton sending={sending} onSend={onSend} onStop={onStop} blockedReason={blocked} />
      </div>
    </form>
  );
}

function modelNotice(modelId: string | undefined): string | null {
  const catalog = inferenceConfig();
  if (!catalog.configured)
    return 'AI replies are not configured. Ask your administrator to configure an inference provider.';
  const model = catalog.models.find(({ id }) => id === (modelId ?? catalog.defaultModel));
  if (
    !model ||
    model.supportsTools === false ||
    !model.inputModalities.includes('text') ||
    !model.outputModalities.includes('text')
  )
    return 'This persona’s model is unavailable. Edit the persona to select an available model.';
  return null;
}

function ComposerNotices({ notices }: { notices: (string | null)[] }) {
  return notices.filter(Boolean).map((notice) => (
    <p className="composer-limit" role="status" key={notice}>
      {notice}
    </p>
  ));
}
