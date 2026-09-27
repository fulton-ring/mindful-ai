import { type RefObject, useEffect, useRef, useState } from 'react';
import { type AttachmentMetadata, uploadAttachment } from '../../../../../lib/api';
import { failureDetails, fileAnalytics, track } from '../../../../../lib/telemetry';
import type { ChatPanelProps } from '../../chat-panel-types';
import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatRuntimeState } from '../state/use-chat-runtime-state';

/** An uploaded file and the conversation its attachment URL lives under. */
export type UploadedFile = AttachmentMetadata & { conversationId: string };
type Upload = { progress: number; metadata?: UploadedFile; controller: AbortController };

function useUploadConversationId(props: ChatPanelProps, runtime: ChatRuntimeState) {
  const promise = useRef<Promise<string> | null>(null);
  useEffect(() => {
    if (props.scopeId === null) promise.current = null;
  }, [props.scopeId]);
  return async () => {
    if (props.scopeId) return props.scopeId;
    if (!promise.current) {
      runtime.awaitingConversationAdoption.current = true;
      promise.current = props.onEnsureConversation().then((conversation) => conversation.id);
    }
    try {
      return await promise.current;
    } catch (error) {
      runtime.awaitingConversationAdoption.current = false;
      promise.current = null;
      throw error;
    }
  };
}

function useUploadCleanup(
  uploads: RefObject<Map<File, Upload>>,
  setProgress: (value: Map<File, number>) => void,
  scopeId: string | null,
) {
  const previousScope = useRef(scopeId);
  useEffect(
    () => () => {
      for (const upload of uploads.current.values()) upload.controller.abort();
    },
    [],
  );
  useEffect(() => {
    const previous = previousScope.current;
    previousScope.current = scopeId;
    if (previous === scopeId || (previous === null && scopeId !== null)) return;
    for (const upload of uploads.current.values()) upload.controller.abort();
    uploads.current.clear();
    setProgress(new Map());
  }, [scopeId]);
}

export function useChatUploads(
  props: ChatPanelProps,
  display: ChatDisplayState,
  runtime: ChatRuntimeState,
) {
  const uploads = useRef(new Map<File, Upload>());
  const [progress, setProgress] = useState(new Map<File, number>());
  const conversationId = useUploadConversationId(props, runtime);
  useUploadCleanup(uploads, setProgress, props.scopeId);

  function publishProgress() {
    setProgress(new Map([...uploads.current].map(([file, upload]) => [file, upload.progress])));
  }

  function removeAttachment(file: File, userInitiated = true) {
    if (userInitiated) track('file_attachment_removed', fileAnalytics(file));
    uploads.current.get(file)?.controller.abort();
    uploads.current.delete(file);
    display.setAttachments((current) => current.filter((item) => item !== file));
    publishProgress();
  }

  function addAttachments(files: File[]) {
    display.setError('');
    display.setAttachments((current) => [...current, ...files]);
    for (const file of files) {
      track('file_upload_started', fileAnalytics(file));
      const upload: Upload = { progress: 0, controller: new AbortController() };
      uploads.current.set(file, upload);
      publishProgress();
      void (async () => {
        try {
          const id = await conversationId();
          if (upload.controller.signal.aborted) return;
          const metadata = await uploadAttachment(id, file, upload.controller.signal, (value) => {
            upload.progress = value;
            publishProgress();
          });
          upload.metadata = { ...metadata, conversationId: id };
          upload.progress = 100;
          publishProgress();
          track('file_upload_completed', fileAnalytics(file));
        } catch (error) {
          if (upload.controller.signal.aborted) return;
          track('file_upload_failed', { ...fileAnalytics(file), ...failureDetails(error) });
          removeAttachment(file, false);
          display.setError(
            `Could not upload ${file.name}: ${error instanceof Error ? error.message : 'Upload failed.'}`,
          );
        }
      })();
    }
  }

  function uploaded(files: File[]): UploadedFile[] | null {
    const values = files.map((file) => uploads.current.get(file)?.metadata);
    return values.every((value): value is UploadedFile => Boolean(value)) ? values : null;
  }

  function clearSent(files: File[]) {
    for (const file of files) uploads.current.delete(file);
    publishProgress();
  }

  function restore(files: File[], metadata: UploadedFile[]) {
    files.forEach((file, index) => {
      const item = metadata[index];
      if (item)
        uploads.current.set(file, {
          progress: 100,
          metadata: item,
          controller: new AbortController(),
        });
    });
    publishProgress();
  }

  return { progress, addAttachments, removeAttachment, uploaded, clearSent, restore };
}
