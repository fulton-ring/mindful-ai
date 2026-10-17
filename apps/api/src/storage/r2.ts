import type { ObjectStore } from './object-store';
import { createS3ObjectStore } from './s3';
export type R2SigningConfig = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
/** Uses the real native R2 binding; only signing uses its S3-compatible endpoint. */
export function createR2ObjectStore(bucket: ObjectStore, config?: R2SigningConfig): ObjectStore {
  const signing =
    config &&
    createS3ObjectStore({
      bucket: config.bucket,
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  return {
    get: bucket.get.bind(bucket),
    head: bucket.head.bind(bucket),
    put: bucket.put.bind(bucket),
    delete: bucket.delete.bind(bucket),
    list: bucket.list.bind(bucket),
    ...(signing ? { uploadMode: 'presigned', presignPut: signing.presignPut!.bind(signing) } : {}),
  };
}
