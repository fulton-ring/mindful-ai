import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type ObjectMetadata,
  type ObjectStore,
  type ObjectValue,
  objectBytes,
  type PutObjectOptions,
  type StoredObject,
} from './object-store';
export type S3ObjectStoreConfig = S3ClientConfig & {
  bucket: string;
  client?: S3Client;
  publicEndpoint?: string;
};
const METADATA_UTF8 = 'walden:utf8:';
function encodeMetadata(metadata?: Record<string, string>) {
  return (
    metadata &&
    Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [
        key,
        /^[\x20-\x7e]*$/.test(value) && !value.startsWith(METADATA_UTF8)
          ? value
          : METADATA_UTF8 + Buffer.from(value, 'utf8').toString('base64url'),
      ]),
    )
  );
}
function decodeMetadata(metadata?: Record<string, string>) {
  return (
    metadata &&
    Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [
        key,
        value.startsWith(METADATA_UTF8)
          ? Buffer.from(value.slice(METADATA_UTF8.length), 'base64url').toString('utf8')
          : value,
      ]),
    )
  );
}
function status(error: unknown) {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}
function etag(value?: string) {
  return value?.replace(/^"|"$/g, '') ?? '';
}
export class S3ObjectStore implements ObjectStore {
  readonly uploadMode = 'presigned';
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signer: S3Client;
  constructor({ bucket, client, publicEndpoint, ...config }: S3ObjectStoreConfig) {
    this.bucket = bucket;
    this.client =
      client ?? new S3Client({ ...config, requestChecksumCalculation: 'WHEN_REQUIRED' });
    this.signer = publicEndpoint
      ? new S3Client({
          ...config,
          endpoint: publicEndpoint,
          requestChecksumCalculation: 'WHEN_REQUIRED',
        })
      : this.client;
  }
  private metadata(
    key: string,
    output: {
      ContentLength?: number;
      ETag?: string;
      LastModified?: Date;
      ContentType?: string;
      CacheControl?: string;
      ContentDisposition?: string;
      ContentEncoding?: string;
      ContentLanguage?: string;
      Metadata?: Record<string, string>;
    },
  ): ObjectMetadata {
    return {
      key,
      size: output.ContentLength ?? 0,
      etag: etag(output.ETag),
      uploaded: output.LastModified ?? new Date(0),
      httpMetadata: {
        contentType: output.ContentType,
        cacheControl: output.CacheControl,
        contentDisposition: output.ContentDisposition,
        contentEncoding: output.ContentEncoding,
        contentLanguage: output.ContentLanguage,
      },
      customMetadata: decodeMetadata(output.Metadata),
    };
  }
  async head(key: string) {
    try {
      return this.metadata(
        key,
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })),
      );
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
  }
  async get(key: string): Promise<StoredObject | null> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      let stream: ReadableStream<Uint8Array> | undefined;
      const body = () =>
        (stream ??=
          output.Body?.transformToWebStream() ??
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }));
      return {
        ...this.metadata(key, output),
        get body() {
          return body();
        },
        arrayBuffer: async () => new Response(body()).arrayBuffer(),
        text: async () => new Response(body()).text(),
      };
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
  }
  async put(key: string, value: ObjectValue, options: PutObjectOptions = {}) {
    const bytes = await objectBytes(value);
    const metadata = options.httpMetadata;
    try {
      const output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: metadata?.contentType,
          CacheControl: metadata?.cacheControl,
          ContentDisposition: metadata?.contentDisposition,
          ContentEncoding: metadata?.contentEncoding,
          ContentLanguage: metadata?.contentLanguage,
          Metadata: encodeMetadata(options.customMetadata),
          IfMatch: options.onlyIf?.etagMatches,
          IfNoneMatch: options.onlyIf?.etagDoesNotMatch,
        }),
      );
      return {
        key,
        size: bytes.byteLength,
        etag: etag(output.ETag),
        uploaded: new Date(),
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      };
    } catch (error) {
      if (status(error) === 412 || status(error) === 409) return null;
      throw error;
    }
  }
  async delete(keys: string | string[]) {
    const values = typeof keys === 'string' ? [keys] : keys;
    for (let offset = 0; offset < values.length; offset += 1000) {
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: values.slice(offset, offset + 1000).map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      if (result.Errors?.length)
        throw new Error(
          `Could not delete objects: ${result.Errors.map((error) => error.Code).join(', ')}`,
        );
    }
  }
  async list(options: Parameters<ObjectStore['list']>[0] = {}) {
    const output = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: options.prefix,
        ContinuationToken: options.cursor,
        MaxKeys: Math.max(1, Math.min(options.limit ?? 1000, 1000)),
      }),
    );
    const objects = await Promise.all(
      (output.Contents ?? [])
        .filter((object) => object.Key)
        .map(async (object) =>
          options.include?.length
            ? await this.head(object.Key!)
            : {
                key: object.Key!,
                size: object.Size ?? 0,
                etag: etag(object.ETag),
                uploaded: object.LastModified ?? new Date(0),
              },
        ),
    );
    return {
      objects: objects.filter((object): object is ObjectMetadata => object !== null),
      truncated: Boolean(output.IsTruncated),
      cursor: output.NextContinuationToken,
    };
  }
  presignPut(key: string, contentType: string, expiresIn = 120) {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: Math.min(expiresIn, 120), signableHeaders: new Set(['content-type']) },
    );
  }
}
export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  return new S3ObjectStore(config);
}
