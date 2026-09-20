import { S3Filesystem } from '@mastra/s3';

export type R2FilesystemConfig = {
  accountId?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

type R2FilesystemInput = {
  config: R2FilesystemConfig;
  ownerId: string;
  threadId: string;
};

const REQUIRED_CONFIG = ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'] as const;

export function createR2Filesystem({ config, ownerId, threadId }: R2FilesystemInput) {
  const configured = REQUIRED_CONFIG.filter((key) => config[key]?.trim());
  if (configured.length === 0) return undefined;

  const missing = REQUIRED_CONFIG.filter((key) => !config[key]?.trim());
  if (missing.length > 0)
    throw new Error(`Incomplete R2 filesystem configuration: missing ${missing.join(', ')}`);
  if (!ownerId.trim() || !threadId.trim())
    throw new Error('R2 filesystem requires an authenticated owner ID and thread ID');

  return new S3Filesystem({
    id: 'walden-r2-files',
    bucket: config.bucket!,
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    accessKeyId: config.accessKeyId!,
    secretAccessKey: config.secretAccessKey!,
    prefix: `owners/${encodeURIComponent(ownerId)}/threads/${encodeURIComponent(threadId)}`,
    readOnly: true,
  });
}
