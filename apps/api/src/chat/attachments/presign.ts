import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpError } from '../../http';
import {
  attachmentKey,
  DEFAULT_UPLOAD_LIMITS,
  DOCUMENT_TYPES,
  stagingAttachmentKey,
  type UploadLimits,
  validateAttachmentCount,
  validateAttachmentFile,
  validateAttachmentSize,
} from './attachments';

export type { R2SigningConfig } from '../../storage/r2';

import {
  ObjectSizeLimitError,
  type ObjectStore,
  readObjectBytes,
} from '../../storage/object-store';
import type { R2SigningConfig } from '../../storage/r2';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function attachmentMimeType(name: string, declaredMimeType: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (!extension) throw new HttpError(415, 'File names need a supported extension.');
  if (DOCUMENT_TYPES[extension]) return DOCUMENT_TYPES[extension];
  if (IMAGE_MIME[extension]) {
    if (declaredMimeType !== IMAGE_MIME[extension])
      throw new HttpError(415, 'File type does not match its name.');
    return declaredMimeType;
  }
  validateAttachmentFile(new File(['x'], name, { type: 'text/plain' }));
  return 'text/plain';
}

export async function presignUpload(
  config: R2SigningConfig,
  ownerId: string,
  conversationId: string,
  id: string,
  mimeType: string,
): Promise<string> {
  const client = new S3Client({
    region: 'auto',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: stagingAttachmentKey(ownerId, conversationId, id),
      ContentType: mimeType,
    }),
    { expiresIn: 120, signableHeaders: new Set(['content-type']) },
  );
}

function validBytes(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'application/pdf')
    return new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
  if (mimeType === DOCUMENT_TYPES.docx || mimeType === DOCUMENT_TYPES.xlsx)
    return bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (mimeType === 'image/png')
    return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mimeType === 'image/webp')
    return (
      new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
    );
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function validateAttachmentBytes(bytes: Uint8Array, mimeType: string): void {
  if (!validBytes(bytes, mimeType))
    throw new HttpError(415, 'Uploaded file contents do not match the file type.');
}

export async function completeUpload(
  bucket: ObjectStore,
  ownerId: string,
  conversationId: string,
  id: string,
  name: string,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): Promise<{ id: string; name: string; mimeType: string; size: number }> {
  const stagingKey = stagingAttachmentKey(ownerId, conversationId, id);
  const metadata = await bucket.head(stagingKey);
  if (!metadata) throw new HttpError(404, 'Uploaded file not found.');
  try {
    validateAttachmentCount(1, limits.maxFiles);
    validateAttachmentSize(metadata.size, limits.maxBytes);
  } catch (error) {
    await bucket.delete(stagingKey);
    throw error;
  }
  const object = await bucket.get(stagingKey);
  if (!object) throw new HttpError(404, 'Uploaded file not found.');
  try {
    validateAttachmentSize(object.size, limits.maxBytes);
    const mimeType = attachmentMimeType(name, object.httpMetadata?.contentType ?? '');
    if (object.httpMetadata?.contentType !== mimeType)
      throw new HttpError(415, 'Uploaded file type does not match.');
    const bytes = await readObjectBytes(object, limits.maxBytes ?? object.size);
    validateAttachmentFile(new File([bytes], name, { type: mimeType }), limits);
    validateAttachmentBytes(bytes, mimeType);
    const safeName = name.slice(0, 180);
    const stored = await bucket.put(attachmentKey(ownerId, conversationId, id), bytes, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { name: safeName },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (stored === null) throw new HttpError(409, 'Attachment was already finalized.');
    return { id, name: safeName, mimeType, size: bytes.byteLength };
  } catch (error) {
    if (error instanceof ObjectSizeLimitError)
      throw new HttpError(413, 'Uploaded file exceeds its byte limit.');
    throw error;
  } finally {
    await object.body?.cancel().catch(() => undefined);
    await bucket.delete(stagingKey);
  }
}
