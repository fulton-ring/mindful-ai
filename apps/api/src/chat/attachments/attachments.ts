import { HttpError } from '../../http';
import { type ObjectStore, readObjectBytes } from '../../storage/object-store';

export const MAX_ATTACHMENT_BYTES = 1_000_000;
export const MAX_ATTACHMENTS = 5;
const TEXT_EXTENSIONS =
  /\.(md|markdown|txt|csv|json|ts|tsx|js|jsx|py|sql|html|css|xml|yaml|yml|toml|sh|log)$/i;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export type LoadedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  bytes?: Uint8Array;
};

export function attachmentKey(ownerId: string, conversationId: string, id: string): string {
  return `owners/${encodeURIComponent(ownerId)}/threads/${encodeURIComponent(conversationId)}/attachments/${id}`;
}

export function stagingAttachmentKey(ownerId: string, conversationId: string, id: string): string {
  return `staging/${encodeURIComponent(ownerId)}/threads/${encodeURIComponent(conversationId)}/${id}`;
}

export function attachmentWorkspacePath(id: string, name: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? 'txt';
  return `/attachments/${id}.${extension}`;
}

export async function deleteAttachmentPrefix(
  bucket: ObjectStore,
  ownerId: string,
  conversationId?: string,
) {
  const owner = encodeURIComponent(ownerId);
  const thread = conversationId ? `threads/${encodeURIComponent(conversationId)}/` : 'threads/';
  for (const prefix of [`owners/${owner}/${thread}`, `staging/${owner}/${thread}`]) {
    while (true) {
      const page = await bucket.list({ prefix, limit: 1000 });
      if (!page.objects.length) break;
      await bucket.delete(page.objects.map(({ key }) => key));
    }
  }
}

export function validateAttachmentFile(file: File): 'text' | 'image' | 'document' {
  if (file.size < 1 || file.size > MAX_ATTACHMENT_BYTES)
    throw new HttpError(413, 'Files must be between 1 byte and 1 MB.');
  if (IMAGE_TYPES.has(file.type)) return 'image';
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (extension && DOCUMENT_TYPES[extension]) return 'document';
  if (TEXT_EXTENSIONS.test(file.name)) return 'text';
  throw new HttpError(415, 'Only supported text, document, and image files can be attached.');
}

export async function loadAttachments(
  bucket: ObjectStore,
  ownerId: string,
  conversationId: string,
  ids: readonly string[],
): Promise<LoadedAttachment[]> {
  if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length)
    throw new HttpError(400, 'Choose up to five distinct files.');
  return Promise.all(
    ids.map(async (id) => {
      if (!/^[a-f0-9-]{36}$/.test(id) && !/^[a-z0-9-]{1,60}$/.test(id))
        throw new HttpError(400, 'Invalid attachment ID.');
      const object = await bucket.get(attachmentKey(ownerId, conversationId, id));
      if (!object || object.size > MAX_ATTACHMENT_BYTES) {
        await object?.body?.cancel();
        throw new HttpError(404, 'An attachment is missing or too large.');
      }
      const mimeType = object.httpMetadata?.contentType ?? 'application/octet-stream';
      const name = object.customMetadata?.name ?? 'Attachment';
      const bytes = await readObjectBytes(object, MAX_ATTACHMENT_BYTES);
      const kind = validateAttachmentFile(new File([bytes], name, { type: mimeType }));
      return {
        id,
        name,
        mimeType,
        size: bytes.byteLength,
        ...(kind === 'image' ? { bytes } : {}),
      };
    }),
  );
}
