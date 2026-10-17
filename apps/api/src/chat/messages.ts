import {
  attachmentUrl,
  type WaldenMessageMetadata,
  type WaldenUIMessage,
  type WaldenUIMessageChunk,
} from '@walden/contracts';
import { isToolUIPart, readUIMessageStream, type UIMessageChunk } from 'ai';
import type { SqlDialect } from '../db/database';
import type { LoadedAttachment } from './attachments/attachments';

type AttachmentRef = Pick<LoadedAttachment, 'id' | 'name' | 'mimeType'>;
type Part = WaldenUIMessage['parts'][number];

/** SQL predicate: the aliased message row is not an interrupted reply. */
export const notInterruptedSql = (alias: string, dialect: SqlDialect = 'sqlite') =>
  dialect === 'postgres'
    ? `(${alias}.ui_message::jsonb #>> '{metadata,status}') IS DISTINCT FROM 'interrupted'`
    : `json_extract(${alias}.ui_message,'$.metadata.status') IS NOT 'interrupted'`;

export const isInterrupted = (message: Pick<WaldenUIMessage, 'metadata'>) =>
  message.metadata?.status === 'interrupted';

/** A partial metadata update, merged by the client and by `readUIMessageStream`. */
export const metadataPatch = (patch: Partial<WaldenMessageMetadata>) =>
  patch as WaldenMessageMetadata;

export const transientStatus = (text: string): WaldenUIMessageChunk => ({
  type: 'data-status',
  data: { text },
  transient: true,
});

export const attachmentPart = (conversationId: string, attachment: AttachmentRef): Part => ({
  type: 'file',
  mediaType: attachment.mimeType,
  filename: attachment.name,
  url: attachmentUrl(conversationId, attachment.id),
});

/** Attachments referenced by a message's `file` parts (served attachment URLs only). */
export function messageAttachments(message: Pick<WaldenUIMessage, 'parts'>): AttachmentRef[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'file' || !part.url.startsWith('/api/chat/attachments/')) return [];
    const id = decodeURIComponent(part.url.split('/').at(-1) ?? '');
    return id ? [{ id, name: part.filename ?? 'file', mimeType: part.mediaType }] : [];
  });
}

/** Stored JSON omits what is attached on load from `message_highlights`. */
export function storedMessageJson(message: WaldenUIMessage): string {
  const {
    highlights: _highlights,
    annotations: _annotations,
    ...metadata
  } = message.metadata ?? {
    createdAt: new Date().toISOString(),
  };
  return JSON.stringify({ ...message, metadata });
}

export const parseStoredMessage = (json: string) => JSON.parse(json) as WaldenUIMessage;

function chunkStream(chunks: readonly WaldenUIMessageChunk[]) {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) if (chunk.type !== 'error') controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Replays a turn's stored chunks into the assistant message they describe. */
export async function buildUIMessage(
  id: string,
  chunks: readonly WaldenUIMessageChunk[],
): Promise<WaldenUIMessage> {
  let message: WaldenUIMessage = { id, role: 'assistant', parts: [] };
  for await (const snapshot of readUIMessageStream<WaldenUIMessage>({
    message,
    stream: chunkStream(chunks),
  }))
    message = snapshot;
  return message;
}

function settlePart(part: Part): Part {
  if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming')
    return { ...part, state: 'done' };
  if (isToolUIPart(part) && (part.state === 'input-streaming' || part.state === 'input-available'))
    return {
      ...part,
      state: 'output-error',
      input: part.input ?? {},
      errorText: 'Stopped',
    } as Part;
  return part;
}

/** An interrupted reply keeps its parts, with anything still in flight closed off. */
export function settleInterrupted(message: WaldenUIMessage, now: string): WaldenUIMessage {
  return {
    ...message,
    parts: message.parts.map(settlePart),
    metadata: {
      ...message.metadata,
      createdAt: message.metadata?.createdAt ?? now,
      status: 'interrupted',
    },
  };
}
