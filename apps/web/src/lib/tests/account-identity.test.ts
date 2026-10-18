import { afterEach, expect, it, vi } from 'vitest';
import {
  beginIdentitySession,
  bindAccountIdentity,
  identityRequestScope,
  invalidateAccountIdentity,
} from '../account-identity';
import { api, setTokenProvider } from '../api';

afterEach(() => {
  beginIdentitySession();
  setTokenProvider(null);
  vi.unstubAllGlobals();
});
it('binds the document to one account and aborts old requests before another account can be installed', () => {
  beginIdentitySession();
  expect(bindAccountIdentity('account-a')).toBe(true);
  const scope = identityRequestScope();
  expect(scope.accountId).toBe('account-a');
  expect(bindAccountIdentity('account-b')).toBe(false);
  expect(scope.signal.aborted).toBe(true);
  expect(() => identityRequestScope()).toThrow(/Reload/);
});
it('sends the internal account header through an auth retry', async () => {
  beginIdentitySession();
  bindAccountIdentity('account-a');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
    .mockResolvedValueOnce(Response.json([]));
  vi.stubGlobal('fetch', fetch);
  setTokenProvider(async (options) => (options?.skipCache ? 'fresh-token' : 'old-token'));
  await api.notes();
  for (const [, init] of fetch.mock.calls)
    expect(new Headers(init.headers).get('X-Walden-Account-Id')).toBe('account-a');
});
it('never sends an old-account mutation whose token resolves after identity invalidation', async () => {
  beginIdentitySession();
  bindAccountIdentity('account-a');
  let resolveToken!: (token: string) => void;
  setTokenProvider(
    () =>
      new Promise<string>((resolve) => {
        resolveToken = resolve;
      }),
  );
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const pending = api.renameNote('note-a', 'A draft');
  invalidateAccountIdentity();
  resolveToken('late-token');
  await expect(pending).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('invalidates the document when the server detects a stale account cookie', async () => {
  beginIdentitySession();
  bindAccountIdentity('account-a');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          error: 'Your account changed. Reload Walden.',
          details: { code: 'auth_identity_changed' },
        },
        { status: 409 },
      ),
    ),
  );
  await expect(api.notes()).rejects.toThrow(/Reload/);
  expect(() => identityRequestScope()).toThrow(/Reload/);
});
it('discards successful old-account responses whose body finishes after invalidation', async () => {
  beginIdentitySession();
  bindAccountIdentity('account-a');
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  const pending = api.renameNote('note-a', 'A private draft');
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  invalidateAccountIdentity();
  body.enqueue(new TextEncoder().encode('{"title":"A private draft"}'));
  body.close();
  await expect(pending).rejects.toThrow(/Reload/);
});
it('carries the captured account on local upload progress and refreshed-token retries', async () => {
  const { uploadAttachment } = await import('../api');
  beginIdentitySession();
  bindAccountIdentity('account-a');
  setTokenProvider(async (options) => (options?.skipCache ? 'fresh-token' : 'old-token'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ mode: 'local' })));
  const requests: Record<string, string>[] = [];
  class UploadRequest {
    upload = {};
    status = 200;
    responseText = '{"id":"local-file"}';
    onload?: () => void;
    headers: Record<string, string> = {};
    open() {}
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send() {
      requests.push(this.headers);
      this.status = requests.length === 1 ? 401 : 200;
      this.onload?.();
    }
    abort() {}
  }
  vi.stubGlobal('XMLHttpRequest', UploadRequest);
  const result = await uploadAttachment(
    'thread-a',
    new File(['A draft'], 'note.txt', { type: 'text/plain' }),
    undefined,
    vi.fn(),
  );
  expect(result.id).toBe('local-file');
  expect(requests).toEqual([
    { 'X-Walden-Account-Id': 'account-a', authorization: 'Bearer old-token' },
    { 'X-Walden-Account-Id': 'account-a', authorization: 'Bearer fresh-token' },
  ]);
});
