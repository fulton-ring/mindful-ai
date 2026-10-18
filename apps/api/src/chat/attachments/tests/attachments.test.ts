import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../http';
import { chatRoutes } from '../../turns/routes';
import {
  attachmentKey,
  attachmentWorkspacePath,
  deleteAttachmentPrefix,
  loadAttachments,
  stagingAttachmentKey,
  validateAttachmentFile,
} from '../attachments';

describe('attachment preview route', () => {
  it('requires signing credentials outside the explicit local fallback', async () => {
    const first = vi.fn(async () => ({ id: 'thread' }));
    const db = { prepare: () => ({ bind: () => ({ first }) }) } as unknown as D1Database;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.onError((error, c) =>
      c.text(error.message, error instanceof HttpError ? error.status : 500),
    );
    app.use('*', async (c, next) => {
      c.set('userId', 'owner');
      await next();
    });
    app.route('/api/chat', chatRoutes);
    const path = '/api/chat/attachments/thread/initiate';
    const body = JSON.stringify({ name: 'notes.md', mimeType: 'text/markdown', size: 5 });
    const env = { DB: db, FILES: {} as R2Bucket };
    const unavailable = await app.request(path, { method: 'POST', body }, env);
    expect(unavailable.status).toBe(503);
    const local = await app.request(
      path,
      { method: 'POST', body },
      {
        ...env,
        UPLOAD_LOCAL_FALLBACK: 'true',
      },
    );
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ mode: 'local' });
  });

  it('serves a saved file only from its owner-scoped thread', async () => {
    const first = vi.fn(async () => ({ id: 'thread' }));
    const get = vi.fn(async () => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.close();
        },
      }),
      httpMetadata: { contentType: 'text/plain' },
    }));
    const db = { prepare: () => ({ bind: () => ({ first }) }) } as unknown as D1Database;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.onError((error, c) => c.text(error.message, error instanceof HttpError ? 404 : 500));
    app.use('*', async (c, next) => {
      c.set('userId', 'owner');
      await next();
    });
    app.route('/api/chat', chatRoutes);
    const id = '00112233-4455-6677-8899-aabbccddeeff';
    const path = `/api/chat/attachments/thread/${id}`;
    const env = { DB: db, FILES: { get } as unknown as R2Bucket };
    const own = await app.request(path, {}, env);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('hello');
    expect(get).toHaveBeenCalledWith(attachmentKey('owner', 'thread', id));
    first.mockResolvedValueOnce(null as never);
    const other = await app.request(path, {}, env);
    expect(other.status).toBe(404);
    expect(get).toHaveBeenCalledOnce();
  });
});

describe('attachment cleanup', () => {
  it('deletes staged and finalized objects when a thread is removed', async () => {
    const keys = new Set([
      attachmentKey('owner', 'thread', 'one'),
      stagingAttachmentKey('owner', 'thread', 'two'),
      attachmentKey('owner', 'other', 'keep'),
    ]);
    const bucket = {
      async list({ prefix }: { prefix: string }) {
        return {
          objects: [...keys].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        };
      },
      async delete(values: string[]) {
        values.forEach((key) => keys.delete(key));
      },
    };
    await deleteAttachmentPrefix(bucket as never, 'owner', 'thread');
    expect([...keys]).toEqual([attachmentKey('owner', 'other', 'keep')]);
  });
});

describe('attachment buffer safety', () => {
  it('loads accepted text/document metadata without buffering their object bodies', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
      cancel,
    });
    const read = vi.spyOn(body, 'getReader');
    const bucket = {
      get: async () => ({
        size: 100_000_000,
        body,
        customMetadata: { name: 'large.pdf' },
        httpMetadata: { contentType: 'application/pdf' },
      }),
    };
    expect((await loadAttachments(bucket as never, 'owner', 'thread', ['accepted']))[0]?.size).toBe(
      100_000_000,
    );
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects oversized inline images before allocating their bytes independently of quota', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array(1).buffer);
    const bucket = {
      get: async () => ({
        size: 32_000_001,
        httpMetadata: { contentType: 'image/png' },
        customMetadata: { name: 'large.png' },
        arrayBuffer,
      }),
    };
    await expect(loadAttachments(bucket as never, 'owner', 'thread', ['accepted'])).rejects.toThrow(
      'image',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe('attachment account limits', () => {
  it('uses finite, zero and unlimited account limits for new uploads', () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    expect(() => validateAttachmentFile(file, { maxBytes: 3, maxFiles: 1 })).toThrow();
    expect(() => validateAttachmentFile(file, { maxBytes: null, maxFiles: 0 })).toThrow();
    expect(
      validateAttachmentFile(
        new File([new Uint8Array(1_000_001)], 'large.txt', { type: 'text/plain' }),
        { maxBytes: null, maxFiles: null },
      ),
    ).toBe('text');
  });

  it('reads previously accepted larger files after downgrade but enforces new reference counts', async () => {
    const bytes = new Uint8Array(1_000_001).fill(120);
    const get = async () => ({
      size: bytes.length,
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { name: 'large.txt' },
      arrayBuffer: async () => bytes.buffer,
    });
    const bucket = { get } as never;
    const limits = { maxBytes: 3, maxFiles: 1 };
    expect((await loadAttachments(bucket, 'owner', 'thread', ['one'], limits))[0]?.size).toBe(
      bytes.length,
    );
    await expect(
      loadAttachments(bucket, 'owner', 'thread', ['one', 'two'], limits),
    ).rejects.toThrow();
    expect(
      await loadAttachments(
        bucket,
        'owner',
        'thread',
        ['one', 'two', 'three', 'four', 'five', 'six'],
        { maxBytes: null, maxFiles: null },
      ),
    ).toHaveLength(6);
    expect(
      await loadAttachments(bucket, 'owner', 'thread', [
        'one',
        'two',
        'three',
        'four',
        'five',
        'six',
      ]),
    ).toHaveLength(6);
  });
});

describe('chat attachments', () => {
  it('rejects files above the free limit and unsupported media', () => {
    expect(() =>
      validateAttachmentFile(new File(['x'], 'x.exe', { type: 'application/octet-stream' })),
    ).toThrow();
    expect(() =>
      validateAttachmentFile(
        new File([new Uint8Array(1_000_001)], 'large.md', { type: 'text/markdown' }),
      ),
    ).toThrow();
  });

  it('keeps object names inside the owner and conversation prefix', () => {
    expect(attachmentKey('owner/one', 'thread/two', 'abc')).toBe(
      'owners/owner%2Fone/threads/thread%2Ftwo/attachments/abc',
    );
  });

  it('gives text files searchable extension-aware paths and isolates pending uploads', () => {
    expect(attachmentWorkspacePath('00112233-4455-6677-8899-aabbccddeeff', 'notes.md')).toBe(
      '/attachments/00112233-4455-6677-8899-aabbccddeeff.md',
    );
    expect(stagingAttachmentKey('owner', 'thread', 'id')).toBe('staging/owner/threads/thread/id');
  });

  it('accepts supported documents without decoding their binary bytes as text', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const get = vi.fn(async () => ({
      size: bytes.length,
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { name: 'paper.pdf' },
      arrayBuffer: async () => bytes.buffer,
    }));
    const [document] = await loadAttachments({ get } as unknown as R2Bucket, 'owner', 'thread', [
      'document',
    ]);
    expect(document).toEqual(expect.objectContaining({ name: 'paper.pdf' }));
    expect(document?.bytes).toBeUndefined();
  });

  it('loads image bytes and references text files without putting text in model input', async () => {
    const get = vi.fn(async (key: string) =>
      key.endsWith('/image')
        ? {
            size: 3,
            httpMetadata: { contentType: 'image/png' },
            customMetadata: { name: 'plot.png' },
            arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
          }
        : {
            size: 5,
            httpMetadata: { contentType: 'text/markdown' },
            customMetadata: { name: 'notes.md' },
            arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
          },
    );
    const loaded = await loadAttachments({ get } as unknown as R2Bucket, 'owner', 'thread', [
      'image',
      'text',
    ]);
    expect(loaded).toEqual([
      expect.objectContaining({ id: 'image', name: 'plot.png', bytes: expect.any(Uint8Array) }),
      expect.objectContaining({ id: 'text', name: 'notes.md' }),
    ]);
    expect(get).toHaveBeenCalledWith(attachmentKey('owner', 'thread', 'image'));
  });
});
