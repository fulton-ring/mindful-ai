import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { D1Store } from '@mastra/cloudflare-d1';
import { Memory } from '@mastra/memory';

import { D1ObservationalMemory } from '../d1-observational-memory';

export const usage: LanguageModelV3Usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

export function scriptedModel(
  outputs: string[],
  calls: LanguageModelV3CallOptions[],
): LanguageModelV3 {
  const next = (options: LanguageModelV3CallOptions) => {
    calls.push(options);
    const text = outputs.shift();
    if (!text) throw new Error('Unexpected model call');
    return text;
  };
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'scripted',
    supportedUrls: {},
    async doGenerate(options) {
      return {
        content: [{ type: 'text', text: next(options) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    },
    async doStream(options) {
      const text = next(options);
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: text },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

export async function storageFor(binding: D1Database) {
  const storage = new D1Store({ id: 'integration-memory', binding, tablePrefix: 'agent_' });
  storage.stores.memory = new D1ObservationalMemory({ binding, tablePrefix: 'agent_' });
  await storage.init();
  return storage;
}

export function memoryFor(storage: D1Store, model: LanguageModelV3) {
  return new Memory({
    storage,
    options: {
      readOnly: true,
      lastMessages: 20,
      observationalMemory: {
        model,
        scope: 'thread',
        observation: { messageTokens: 10, bufferTokens: false },
        reflection: { observationTokens: 20 },
      },
    },
  });
}
