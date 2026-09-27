import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentCheckpoints,
  checkpointModel,
  checkpointTools,
  type ModelProgress,
} from '../checkpoints';

function checkpoints(): AgentCheckpoints {
  const saved = new Map<string, unknown>();
  return {
    async do<T>(name: string, callback: () => Promise<T>) {
      if (!saved.has(name)) saved.set(name, JSON.parse(JSON.stringify(await callback())));
      return saved.get(name) as T;
    },
  };
}
function model(parts: LanguageModelV3StreamPart[]): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test',
    supportedUrls: {},
    doGenerate: vi.fn(async () => {
      throw new Error('unused');
    }),
    doStream: vi.fn(async () => ({
      stream: new ReadableStream({
        start(c) {
          for (const part of parts) c.enqueue(part);
          c.close();
        },
      }),
    })),
  };
}
async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return parts;
}
const complete: LanguageModelV3StreamPart[] = [
  { type: 'text-start', id: 'a' },
  { type: 'text-delta', id: 'a', delta: 'hello' },
  { type: 'text-end', id: 'a' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  },
];
describe('durable agent boundaries', () => {
  it('replays successful model streams across new agent executions without provider calls', async () => {
    const provider = model(complete);
    const durable = checkpoints();
    for (let execution = 0; execution < 2; execution++) {
      const wrapped = checkpointModel(provider, durable, 'chat');
      const result = await wrapped.doStream({ prompt: [] });
      expect(await collect(result.stream)).toEqual(complete);
    }
    expect(provider.doStream).toHaveBeenCalledTimes(1);
  });
  it('does not cache partial streams or streamed errors', async () => {
    const provider = model([
      ...complete.slice(0, 2),
      { type: 'error', error: new Error('provider failed') },
    ]);
    const durable = checkpoints();
    for (let execution = 0; execution < 2; execution++) {
      await expect(
        checkpointModel(provider, durable, 'chat').doStream({ prompt: [] }),
      ).rejects.toThrow('provider failed');
    }
    expect(provider.doStream).toHaveBeenCalledTimes(2);
  });
  it('rejects truncated streams and oversized checkpoints', async () => {
    await expect(
      checkpointModel(model(complete.slice(0, 2)), checkpoints(), 'chat').doStream({ prompt: [] }),
    ).rejects.toThrow('finish');
    const huge = [...complete];
    huge[1] = { type: 'text-delta', id: 'a', delta: 'x'.repeat(1024 * 1024) };
    await expect(
      checkpointModel(model(huge), checkpoints(), 'chat').doStream({ prompt: [] }),
    ).rejects.toThrow('checkpoint');
  });
  it('restores tool replay state without rerunning effects', async () => {
    const execute = vi.fn(async () => ({ results: [{ url: 'https://example.com/' }] }));
    const durable = checkpoints();
    for (let execution = 0; execution < 2; execution++) {
      const allowedUrls = new Set<string>();
      const tools = checkpointTools({ searchWeb: { execute } }, durable, (name, result) => {
        if (name === 'searchWeb')
          for (const item of (result as Awaited<ReturnType<typeof execute>>).results)
            allowedUrls.add(item.url);
      });
      await tools.searchWeb.execute();
      expect(allowedUrls.has('https://example.com/')).toBe(true);
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('recreates Date and binary results after JSON checkpoint serialization', async () => {
    const execute = async () => ({ when: new Date('2026-01-01'), bytes: new Uint8Array([1, 2]) });
    const durable = checkpoints();
    for (let execution = 0; execution < 2; execution++) {
      const tools = checkpointTools({ read: { execute } }, durable);
      expect(await tools.read.execute()).toEqual(await execute());
    }
  });
});

it('omits raw request and response bodies from generated checkpoints', async () => {
  const provider = model(complete);
  vi.mocked(provider.doGenerate).mockResolvedValue({
    content: [{ type: 'text', text: 'hello' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: (complete.at(-1) as Extract<LanguageModelV3StreamPart, { type: 'finish' }>).usage,
    warnings: [],
    request: { body: 'x'.repeat(1024 * 1024) },
    response: { id: 'response', timestamp: new Date('2026-01-01'), body: 'x'.repeat(1024 * 1024) },
  });
  const durable = checkpoints();
  const output = await checkpointModel(provider, durable, 'generate').doGenerate({ prompt: [] });
  expect(output.request).toBeUndefined();
  expect(output.response).toEqual({ id: 'response', timestamp: new Date('2026-01-01') });
});

it('caches tool failures without repeating the operation', async () => {
  const durable = checkpoints();
  const execute = vi.fn(async () => {
    throw new Error('Index unavailable');
  });
  for (let execution = 0; execution < 2; execution++) {
    await expect(
      checkpointTools({ search: { execute } }, durable).search.execute(),
    ).rejects.toThrow('Index unavailable');
  }
  expect(execute).toHaveBeenCalledTimes(1);
});

it('forwards the no-retry policy for bounded annotation calls', async () => {
  const observed: Array<{ retries?: number } | undefined> = [];
  const durable: AgentCheckpoints = {
    async do<T>(_name: string, callback: () => Promise<T>, options?: { retries?: number }) {
      observed.push(options);
      return callback();
    },
  };
  await checkpointModel(model(complete), durable, 'annotations', { retries: 0 }).doStream({
    prompt: [],
  });
  expect(observed).toEqual([{ retries: 0 }]);
});

function recordingProgress() {
  const calls: Array<[string, string, unknown?]> = [];
  const progress: ModelProgress = {
    begin: async (call) => {
      calls.push(['begin', call]);
    },
    parts: async (call, parts) => {
      calls.push(['parts', call, parts]);
    },
    end: async (call) => {
      calls.push(['end', call]);
    },
  };
  return { calls, progress };
}

it('previews text parts before the provider finishes and does not preview a live step again', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = model(complete);
  vi.mocked(provider.doStream).mockImplementation(async () => ({
    stream: new ReadableStream({
      async start(c) {
        c.enqueue(complete[0]!);
        c.enqueue(complete[1]!);
        await gate;
        for (const part of complete.slice(2)) c.enqueue(part);
        c.close();
      },
    }),
  }));
  const { calls, progress } = recordingProgress();
  const previewedParts = () =>
    calls.flatMap(([kind, , parts]) =>
      kind === 'parts' ? (parts as LanguageModelV3StreamPart[]) : [],
    );
  const durable = checkpoints();
  const running = checkpointModel(provider, durable, 'chat', undefined, progress).doStream({
    prompt: [],
  });
  try {
    await vi.waitFor(() => expect(previewedParts()).toEqual(complete.slice(0, 2)));
  } finally {
    release();
  }
  expect(await collect((await running).stream)).toEqual(complete);
  expect(calls[0]).toEqual(['begin', 'chat-stream-1']);
  expect(calls.at(-1)).toEqual(['end', 'chat-stream-1']);
  expect(calls.filter(([kind]) => kind === 'begin')).toHaveLength(1);
  expect(previewedParts()).toEqual(complete.slice(0, 3));
  const replayed = recordingProgress();
  await checkpointModel(provider, durable, 'chat', undefined, replayed.progress).doStream({
    prompt: [],
  });
  expect(replayed.calls).toHaveLength(3);
});

it('replays a restored step preview once, as begin, its text parts, and end', async () => {
  const provider = model(complete);
  const durable = checkpoints();
  await checkpointModel(provider, durable, 'chat').doStream({ prompt: [] });
  const { calls, progress } = recordingProgress();
  const restored = await checkpointModel(provider, durable, 'chat', undefined, progress).doStream({
    prompt: [],
  });
  expect(await collect(restored.stream)).toEqual(complete);
  expect(calls).toEqual([
    ['begin', 'chat-stream-1'],
    ['parts', 'chat-stream-1', complete.slice(0, 3)],
    ['end', 'chat-stream-1'],
  ]);
  expect(provider.doStream).toHaveBeenCalledTimes(1);
});
