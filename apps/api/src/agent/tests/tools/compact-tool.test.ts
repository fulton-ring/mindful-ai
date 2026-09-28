import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ compact: vi.fn() }));
vi.mock('../../memory/memory', async (original) => ({
  ...(await original<typeof import('../../memory/memory')>()),
  compactAgentMemory: mocks.compact,
}));

import { createCompactTools } from '../../compact-tool';
import { streamMastraTurn } from '../../mastra-turn';
import { turnInput } from '../fixtures/research-tools';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const stream = (parts: LanguageModelV3StreamPart[]) =>
  new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

/** Asks to compact twice in one step, then answers. */
function compactingModel(calls: LanguageModelV3CallOptions[]): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'compacting',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('streaming only');
    },
    async doStream(options) {
      calls.push(options);
      if (calls.length === 1)
        return {
          stream: stream([
            ...['one', 'two'].map((id) => ({
              type: 'tool-call' as const,
              toolCallId: `compact-${id}`,
              toolName: 'compactConversation',
              input: JSON.stringify({ focus: 'the launch decision' }),
            })),
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
          ]),
        };
      return {
        stream: stream([
          { type: 'text-start', id: 'a' },
          { type: 'text-delta', id: 'a', delta: 'Done, earlier messages are summarized.' },
          { type: 'text-end', id: 'a' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ]),
      };
    },
  };
}

it('compacts once per reply on request and marks the reply as compacted', async () => {
  mocks.compact.mockResolvedValue({ compacted: true, summaryTokens: 42 });
  const signal = new AbortController().signal;
  const input = turnInput();
  const events: WaldenUIMessageChunk[] = [];
  for await (const event of streamMastraTurn({
    input,
    model: compactingModel([]),
    signal,
    tools: createCompactTools({
      db: {} as D1Database,
      ownerId: 'owner',
      conversation: input.conversation,
      model: {} as LanguageModelV3,
      signal,
    }),
  }))
    events.push(event);
  expect(mocks.compact).toHaveBeenCalledOnce();
  expect(mocks.compact.mock.calls[0]?.[3]).toMatchObject({ focus: 'the launch decision' });
  expect(events).toContainEqual({
    type: 'message-metadata',
    messageMetadata: { contextCompacted: true },
  });
  expect(events.filter(({ type }) => type === 'tool-output-error')).toHaveLength(1);
  expect(events.some((event) => event.type === 'text-delta')).toBe(true);
});
