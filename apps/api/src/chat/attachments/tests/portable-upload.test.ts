import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { HttpError } from '../../../http';
import { LocalObjectStore } from '../../../storage/local';
import { chatRoutes } from '../../turns/routes';
import { attachmentKey, stagingAttachmentKey } from '../attachments';

function app() {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.onError((error, c) => c.text(error.message, error instanceof HttpError ? error.status : 500));
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/chat', chatRoutes);
  return app;
}
const db = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'thread' }) }) }) };
it('uploads multipart directly to a local volume and previews only the owning thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'walden-upload-'));
  try {
    const FILES = new LocalObjectStore(root);
    const env = {
      DB: db,
      FILES,
      R2_ACCOUNT_ID: 'old-account',
      R2_BUCKET: 'old-bucket',
      R2_ACCESS_KEY_ID: 'old-key',
      R2_SECRET_ACCESS_KEY: 'old-secret',
    };
    const routes = app();
    const initiated = await routes.request(
      '/chat/attachments/thread/initiate',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'notes.txt', mimeType: 'text/plain', size: 5 }),
      },
      env,
    );
    expect(await initiated.json()).toMatchObject({ mode: 'local' });
    const body = new FormData();
    body.set('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const uploaded = await routes.request(
      '/chat/attachments/thread',
      { method: 'POST', body },
      env,
    );
    expect(uploaded.status).toBe(200);
    const result = (await uploaded.json()) as { id: string };
    expect(await (await FILES.get(attachmentKey('owner', 'thread', result.id)))?.text()).toBe(
      'hello',
    );
    expect((await routes.request(`/chat/attachments/other/${result.id}`, {}, env)).status).toBe(
      404,
    );
    expect(
      await (await routes.request(`/chat/attachments/thread/${result.id}`, {}, env)).text(),
    ).toBe('hello');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('signs only the private owner staging key using the portable store capability', async () => {
  const presignPut = vi.fn(async () => 'https://s3.example/private');
  const result = await app().request(
    '/chat/attachments/thread/initiate',
    {
      method: 'POST',
      body: JSON.stringify({ name: 'notes.txt', mimeType: 'text/plain', size: 5 }),
    },
    { DB: db, FILES: { presignPut } },
  );
  expect(await result.json()).toMatchObject({
    mode: 'presigned',
    uploadUrl: 'https://s3.example/private',
  });
  expect(presignPut).toHaveBeenCalledWith(
    expect.stringMatching(/^staging\/owner\/threads\/thread\//),
    'text/plain',
    120,
  );
});
it('finalizes and validates private S3 staging bytes with the same portable contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'walden-staging-'));
  try {
    const FILES = new LocalObjectStore(root);
    const id = crypto.randomUUID();
    await FILES.put(stagingAttachmentKey('owner', 'thread', id), 'hello', {
      httpMetadata: { contentType: 'text/plain' },
    });
    const result = await app().request(
      `/chat/attachments/thread/${id}/complete`,
      { method: 'POST', body: JSON.stringify({ name: 'notes.txt' }) },
      { DB: db, FILES },
    );
    expect(result.status).toBe(200);
    expect(await FILES.head(stagingAttachmentKey('owner', 'thread', id))).toBeNull();
    expect((await FILES.head(attachmentKey('owner', 'thread', id)))?.customMetadata?.name).toBe(
      'notes.txt',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
