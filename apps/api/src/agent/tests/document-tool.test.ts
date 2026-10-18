import { expect, it, vi } from 'vitest';
import { createDocumentTools } from '../document-tool';

const id = '00112233-4455-6677-8899-aabbccddeeff';
const path = `/attachments/${id}.pdf`;
const input = {
  ownerId: 'owner',
  conversation: { id: 'thread', messages: [] },
  attachments: [{ id, name: 'paper.pdf', mimeType: 'application/pdf', size: 10 }],
} as never;

it('honors parser resource bounds before allocating an oversized accepted document', async () => {
  const cancel = vi.fn();
  const arrayBuffer = vi.fn();
  const extract = vi.fn();
  const bucket = {
    get: async (key: string) =>
      key.endsWith('.md')
        ? null
        : {
            size: 9,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(9));
                controller.close();
              },
              cancel,
            }),
            arrayBuffer,
          },
  };
  const tool = createDocumentTools(
    { FILES: bucket as never, DOCUMENT_EXTRACTOR: { maxInputBytes: 8, extract } },
    input,
  ).extractDocument as unknown as { execute(args: unknown): Promise<unknown> };
  await expect(tool.execute({ path })).rejects.toThrow('parser');
  expect(cancel).toHaveBeenCalledOnce();
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
});

it('extracts a previously accepted larger document without reapplying account byte limits', async () => {
  const bytes = new Uint8Array(1_000_001);
  const extract = vi.fn(async (_input: { bytes: Uint8Array }) => ({
    markdown: 'Large accepted document',
  }));
  const bucket = {
    get: async (key: string) =>
      key.endsWith('.md') ? null : { size: bytes.length, arrayBuffer: async () => bytes.buffer },
    put: vi.fn(),
  };
  const tool = createDocumentTools(
    { FILES: bucket as never, DOCUMENT_EXTRACTOR: { extract } },
    input,
  ).extractDocument as unknown as { execute(args: unknown): Promise<unknown> };
  await expect(tool.execute({ path })).resolves.toMatchObject({ path: `${path}.md` });
  expect(extract.mock.calls[0]?.[0].bytes.byteLength).toBe(bytes.length);
});

it('converts only a thread attachment and caches Markdown for native workspace reads', async () => {
  const stored = new Map<string, { bytes: Uint8Array; name: string; type: string }>();
  const original = new TextEncoder().encode('%PDF-1.4');
  stored.set(`owners/owner/threads/thread/attachments/${id}`, {
    bytes: original,
    name: 'paper.pdf',
    type: 'application/pdf',
  });
  const bucket = {
    async get(key: string) {
      const item = stored.get(key);
      return (
        item && {
          size: item.bytes.byteLength,
          arrayBuffer: async () => item.bytes.buffer,
          httpMetadata: { contentType: item.type },
        }
      );
    },
    async head(key: string) {
      return stored.has(key) ? { size: stored.get(key)?.bytes.length } : null;
    },
    async put(
      key: string,
      value: string,
      options: { customMetadata: { name: string }; httpMetadata: { contentType: string } },
    ) {
      stored.set(key, {
        bytes: new TextEncoder().encode(value),
        name: options.customMetadata.name,
        type: options.httpMetadata.contentType,
      });
    },
  };
  const toMarkdown = vi.fn(async () => ({
    format: 'markdown',
    data: 'violet otter 731',
    tokens: 5,
  }));
  const tool = createDocumentTools({ FILES: bucket as never, AI: { toMarkdown } as never }, input)
    .extractDocument as unknown as { execute: (args: unknown) => Promise<unknown> };
  await expect(tool.execute({ path: '/attachments/other.pdf' })).rejects.toThrow();
  expect(await tool.execute({ path })).toEqual({
    path: `/attachments/${id}.pdf.md`,
    tokens: 5,
  });
  expect(await tool.execute({ path })).toEqual({ path: `/attachments/${id}.pdf.md`, cached: true });
  expect(toMarkdown).toHaveBeenCalledOnce();
  expect(stored.get(`owners/owner/threads/thread/attachments/${id}.md`)).toMatchObject({
    name: 'paper.pdf.md',
    type: 'text/markdown',
  });
});
