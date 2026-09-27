import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
} from '../../../../components/ai-elements/attachments';
import { fetchAttachment } from '../../../../lib/api';
import type { FilePart } from '../../message-parts';

/** A sent attachment: a `file` part whose URL is an authenticated API path. */
type StoredFile = FilePart;
type Props = { file: File | StoredFile; disabled?: boolean; onRemove?(): void };
type Preview =
  | { kind: 'image' | 'pdf' | 'download'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string }
  | null;

const TEXT_EXTENSION =
  /\.(md|markdown|txt|csv|json|ts|tsx|js|jsx|py|sql|html|css|xml|yaml|yml|toml|sh|log)$/i;

async function preparePreview(blob: Blob, name: string, mimeType: string): Promise<Preview> {
  const extension = name.split('.').pop()?.toLowerCase();
  if (mimeType.startsWith('image/')) return { kind: 'image', url: URL.createObjectURL(blob) };
  if (extension === 'pdf') {
    const pdf =
      blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
    return { kind: 'pdf', url: URL.createObjectURL(pdf) };
  }
  if (mimeType.startsWith('text/') || TEXT_EXTENSION.test(name))
    return { kind: 'text', text: await blob.text() };
  return { kind: 'download', url: URL.createObjectURL(blob) };
}

function PreviewContents({ preview, name }: { preview: Preview; name: string }) {
  if (!preview) return <p>Loading file…</p>;
  switch (preview.kind) {
    case 'error':
      return <p role="alert">{preview.message}</p>;
    case 'image':
      return <img src={preview.url} alt={name} />;
    case 'pdf':
      return <iframe src={preview.url} title={name} className="attachment-pdf" />;
    case 'text':
      return <pre>{preview.text}</pre>;
    case 'download':
      return (
        <p>
          Preview is not available for this file.{' '}
          <a href={preview.url} download={name}>
            Download {name}
          </a>
        </p>
      );
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileName(file: File | StoredFile) {
  return file instanceof File ? file.name : (file.filename ?? 'Attachment');
}

async function prepareAttachment(file: File | StoredFile, signal: AbortSignal) {
  const blob = file instanceof File ? file : await fetchAttachment(file.url, signal);
  signal.throwIfAborted();
  const name = fileName(file);
  if (/\.docx$/i.test(name)) {
    downloadBlob(blob, name);
    return null;
  }
  return preparePreview(blob, name, file instanceof File ? file.type : file.mediaType);
}

function usePreview(file: File | StoredFile) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const [preview, setPreview] = useState<Preview>(null);

  function close() {
    controller.current?.abort();
    controller.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setPreview(null);
  }

  useEffect(
    () => () => {
      controller.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  function showError(download: boolean, request: AbortController) {
    if (request.signal.aborted) return;
    if (download) dialog.current?.showModal();
    setPreview({ kind: 'error', message: 'Could not open this file.' });
  }

  async function open() {
    const request = new AbortController();
    controller.current = request;
    const download = /\.docx$/i.test(fileName(file));
    if (!download) {
      setPreview(null);
      dialog.current?.showModal();
    }
    try {
      const next = await prepareAttachment(file, request.signal);
      if (download) return;
      if (request.signal.aborted) {
        if (next && 'url' in next) URL.revokeObjectURL(next.url);
        return;
      }
      if (next && 'url' in next) objectUrl.current = next.url;
      setPreview(next);
    } catch {
      showError(download, request);
    }
  }

  return { dialog, preview, open, close };
}

export function AttachmentBadge({ file, disabled, onRemove }: Props) {
  const { dialog, preview, open, close } = usePreview(file);
  const isLocal = file instanceof File;
  const name = fileName(file);
  return (
    <>
      <Attachment
        data={{
          id: isLocal ? name : file.url,
          type: 'file',
          mediaType: isLocal ? file.type : file.mediaType,
          filename: name,
          url: '',
        }}
        onRemove={onRemove}
      >
        <button
          type="button"
          className="attachment-open"
          onClick={() => void open()}
          disabled={disabled}
          aria-label={`${/\.docx$/i.test(name) ? 'Download' : 'Open'} ${name}`}
        >
          <AttachmentPreview />
          <AttachmentInfo />
        </button>
        <AttachmentRemove label={`Remove ${name}`} />
      </Attachment>
      <dialog ref={dialog} className="attachment-dialog" onClose={close} aria-label={name}>
        <header>
          <strong>{name}</strong>
          <button type="button" aria-label="Close preview" onClick={() => dialog.current?.close()}>
            <X size={18} />
          </button>
        </header>
        <PreviewContents preview={preview} name={name} />
      </dialog>
    </>
  );
}
