import { beforeEach, describe, expect, it, vi } from 'vitest';

const { s3Filesystem } = vi.hoisted(() => ({ s3Filesystem: vi.fn() }));

vi.mock('@mastra/s3', () => ({
  S3Filesystem: s3Filesystem,
}));

import { createR2Filesystem } from './filesystem';

const configured = {
  accountId: 'cloudflare-account',
  bucket: 'walden-files',
  accessKeyId: 'r2-access-key',
  secretAccessKey: 'r2-secret-key',
};

describe('R2 filesystem', () => {
  beforeEach(() => s3Filesystem.mockClear());

  it('returns undefined when R2 is wholly unconfigured', () => {
    expect(
      createR2Filesystem({
        config: {},
        ownerId: 'owner',
        threadId: 'thread',
      }),
    ).toBeUndefined();
    expect(s3Filesystem).not.toHaveBeenCalled();
  });

  it('rejects partial R2 configuration instead of silently disabling files', () => {
    expect(() =>
      createR2Filesystem({
        config: { accountId: configured.accountId, bucket: configured.bucket },
        ownerId: 'owner',
        threadId: 'thread',
      }),
    ).toThrow('Incomplete R2 filesystem configuration: missing accessKeyId, secretAccessKey');
  });

  it('creates a read-only filesystem scoped to the authenticated owner and thread', () => {
    const filesystem = { provider: 's3' };
    s3Filesystem.mockReturnValue(filesystem);

    expect(
      createR2Filesystem({
        config: configured,
        ownerId: 'owner/../other',
        threadId: 'thread/private',
      }),
    ).toBe(filesystem);
    expect(s3Filesystem).toHaveBeenCalledWith({
      id: 'walden-r2-files',
      bucket: 'walden-files',
      region: 'auto',
      endpoint: 'https://cloudflare-account.r2.cloudflarestorage.com',
      accessKeyId: 'r2-access-key',
      secretAccessKey: 'r2-secret-key',
      prefix: 'owners/owner%2F..%2Fother/threads/thread%2Fprivate',
      readOnly: true,
    });
  });

  it('requires non-empty owner and thread identifiers when configured', () => {
    expect(() =>
      createR2Filesystem({ config: configured, ownerId: '', threadId: 'thread' }),
    ).toThrow('R2 filesystem requires an authenticated owner ID and thread ID');
  });
});
