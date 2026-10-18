import { expect, it, vi } from 'vitest';
import { completeUpload, presignUpload } from '../presign';

const config = {
  accountId: '1234567890abcdef',
  bucket: 'walden-test',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};
const id = '00112233-4455-6677-8899-aabbccddeeff';

it('uses the current account byte limit before fetching staged bodies', async () => {
  const get = vi.fn();
  const remove = vi.fn();
  const bucket = { head: async () => ({ size: 5 }), get, delete: remove };
  await expect(
    completeUpload(bucket as never, 'owner', 'thread', id, 'notes.txt', {
      maxBytes: 3,
      maxFiles: 1,
    }),
  ).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});

it('promotes uploads above the old default when the account byte limit is unlimited', async () => {
  const bytes = new Uint8Array(1_000_001).fill(120);
  const put = vi.fn();
  const bucket = {
    head: async () => ({ size: bytes.length }),
    get: async () => ({
      size: bytes.length,
      httpMetadata: { contentType: 'text/plain' },
      arrayBuffer: async () => bytes.buffer,
    }),
    put,
    delete: vi.fn(),
  };
  expect(
    await completeUpload(bucket as never, 'owner', 'thread', id, 'notes.txt', {
      maxBytes: null,
      maxFiles: null,
    }),
  ).toMatchObject({ size: bytes.length });
  expect(put).toHaveBeenCalledOnce();
});

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
    head: vi.fn(async () => ({ size: bytes.length })),
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
    head: vi.fn(async () => ({ size: 1_000_001 })),
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

it('checks staged metadata before fetching oversized bodies', async () => {
  const get = vi.fn();
  const remove = vi.fn();
  const bucket = { head: vi.fn(async () => ({ size: 1_000_001 })), get, delete: remove };
  await expect(completeUpload(bucket as never, 'owner', 'thread', id, 'paper.pdf')).rejects.toThrow(
    '1 MB',
  );
  expect(get).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});
it('cancels staged streams whose actual bytes exceed their declared length', async () => {
  const cancel = vi.fn();
  const put = vi.fn();
  const remove = vi.fn();
  const bucket = {
    head: async () => ({ size: 10 }),
    get: async () => ({
      size: 10,
      httpMetadata: { contentType: 'application/pdf' },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(600_000));
        },
        cancel,
      }),
    }),
    put,
    delete: remove,
  };
  await expect(completeUpload(bucket as never, 'owner', 'thread', id, 'paper.pdf')).rejects.toThrow(
    'limit',
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(put).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});

it('does not sign an empty checksum into legacy R2 URLs', async () => {
  expect(
    new URL(await presignUpload(config, 'owner', 'thread', id, 'text/plain')).searchParams.has(
      'x-amz-checksum-crc32',
    ),
  ).toBe(false);
});
it('cancels and removes staged bytes when MIME detection throws', async () => {
  const cancel = vi.fn();
  const remove = vi.fn();
  const bucket = {
    head: async () => ({ size: 5 }),
    get: async () => ({
      size: 5,
      httpMetadata: { contentType: 'application/octet-stream' },
      body: new ReadableStream({ cancel }),
    }),
    delete: remove,
  };
  await expect(completeUpload(bucket as never, 'owner', 'thread', id, 'bad.exe')).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
});
