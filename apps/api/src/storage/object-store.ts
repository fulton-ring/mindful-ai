/** Portable private object storage; native R2 implements this structural contract. */
export type ObjectMetadata = {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
  };
  customMetadata?: Record<string, string>;
};
export type StoredObject = ObjectMetadata & {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
};
export type ObjectConditions = { etagMatches?: string; etagDoesNotMatch?: string };
export type PutObjectOptions = Pick<ObjectMetadata, 'httpMetadata' | 'customMetadata'> & {
  onlyIf?: ObjectConditions;
};
export type ObjectValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | Blob;
export interface ObjectStore {
  readonly uploadMode?: 'direct' | 'presigned';
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectMetadata | null>;
  put(key: string, value: ObjectValue, options?: PutObjectOptions): Promise<ObjectMetadata | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    include?: ('customMetadata' | 'httpMetadata')[];
  }): Promise<{ objects: ObjectMetadata[]; truncated: boolean; cursor?: string }>;
  presignPut?(key: string, contentType: string, expiresIn?: number): Promise<string>;
}
export async function objectBytes(value: ObjectValue): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export class ObjectSizeLimitError extends Error {
  constructor() {
    super('Object exceeds the byte limit.');
    this.name = 'ObjectSizeLimitError';
  }
}
/** Bound actual bytes as well as metadata; cancel remote streams immediately on overflow. */
export async function readObjectBytes(object: StoredObject, limit: number): Promise<Uint8Array> {
  if (object.size > limit) {
    await object.body?.cancel();
    throw new ObjectSizeLimitError();
  }
  if (!object.body) {
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > limit) throw new ObjectSizeLimitError();
    return bytes;
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ObjectSizeLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
