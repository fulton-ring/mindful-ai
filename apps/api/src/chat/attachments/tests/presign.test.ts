import { expect, it, vi } from 'vitest';
import { completeUpload, presignUpload } from '../presign';

const config = {
  accountId: '1234567890abcdef',
  bucket: 'walden-test',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};
const id = '00112233-4455-6677-8899-aabbccddeeff';

it('signs a short-lived PUT for the caller-scoped staging object', async () => {
  const url = new URL(await presignUpload(config, 'owner', 'thread', id, 'application/pdf'));
  expect(url.hostname).toBe('walden-test.1234567890abcdef.r2.cloudflarestorage.com');
  expect(url.pathname).toContain('staging/owner/threads/thread/');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
  expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
});

it('validates a staged PDF before promoting it and removes the reusable staging object', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4\nsynthetic');
  const put = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const bucket = {
    get: vi.fn(async () => ({
      size: bytes.length,
      httpMetadata: { contentType: 'application/pdf' },
      arrayBuffer: async () => bytes.buffer,
    })),
    put,
    delete: remove,
  };
  const result = await completeUpload(bucket as never, 'owner', 'thread', id, 'paper.pdf');
  expect(result).toEqual({
    id,
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    size: bytes.length,
  });
  expect(put).toHaveBeenCalledWith(
    expect.stringContaining('/attachments/' + id),
    expect.any(Uint8Array),
    expect.objectContaining({
      customMetadata: { name: 'paper.pdf' },
      onlyIf: { etagDoesNotMatch: '*' },
    }),
  );
  expect(remove).toHaveBeenCalledOnce();
});

it('rejects oversized staged bytes before storing the final attachment', async () => {
  const put = vi.fn();
  const remove = vi.fn();
  const bucket = {
    get: vi.fn(async () => ({ size: 1_000_001, httpMetadata: { contentType: 'application/pdf' } })),
    put,
    delete: remove,
  };
  await expect(completeUpload(bucket as never, 'owner', 'thread', id, 'paper.pdf')).rejects.toThrow(
    '1 MB',
  );
  expect(put).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});
