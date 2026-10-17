import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginIdentitySession, bindAccountIdentity } from '../account-identity';
import { uploadAttachment } from '../api';

beforeEach(() => {
  beginIdentitySession();
  bindAccountIdentity('internal-account');
});
afterEach(() => {
  beginIdentitySession();
  vi.unstubAllGlobals();
});

it('uploads bytes directly to a presigned R2 URL before completing the attachment', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (calls.length === 1)
      return Response.json({
        id: 'file-id',
        mode: 'presigned',
        uploadUrl: 'https://bucket.example/upload',
        headers: { 'Content-Type': 'text/plain' },
      });
    if (calls.length === 2) return new Response(null, { status: 200 });
    return Response.json({ id: 'file-id', name: 'notes.md', mimeType: 'text/plain', size: 5 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
  const result = await uploadAttachment('thread', file);
  expect(result.id).toBe('file-id');
  expect(calls.map(([url]) => url)).toEqual([
    '/api/chat/attachments/thread/initiate',
    'https://bucket.example/upload',
    '/api/chat/attachments/thread/file-id/complete',
  ]);
  expect(calls[1]?.[1]).toMatchObject({ method: 'PUT', body: file });
  expect(new Headers(calls[1]?.[1]?.headers).get('authorization')).toBeNull();
  expect(new Headers(calls[1]?.[1]?.headers).get('X-Walden-Account-Id')).toBeNull();
});

it('reports transfer progress and completes only after storage confirms the file', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith('/initiate')
      ? Response.json({
          id: 'file-id',
          mode: 'presigned',
          uploadUrl: 'https://bucket.example/upload',
          headers: {},
        })
      : Response.json({ id: 'file-id', name: 'notes.md', mimeType: 'text/markdown', size: 5 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  class UploadRequest {
    upload: {
      onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
    } = {};
    status = 200;
    responseText = '';
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    open() {}
    setRequestHeader() {}
    send() {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 5 });
      this.onload?.();
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', UploadRequest);
  const progress: number[] = [];
  const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
  const result = await uploadAttachment('thread', file, undefined, (value) => progress.push(value));
  expect(result.id).toBe('file-id');
  expect(progress).toEqual([40, 100]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
