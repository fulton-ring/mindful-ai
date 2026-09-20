import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { D1Store } from '@mastra/cloudflare-d1';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { describe, expect, it } from 'vitest';

import { createCloudflareModel, DEFAULT_AI_MODEL } from '../services/agent';
import { D1ObservationalMemory } from './d1-observational-memory';
import { sqliteD1Binding } from './d1-test-binding';
import { messagesBeforeRecentTokenFloor } from './memory';

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function scriptedModel(outputs: string[], calls: LanguageModelV3CallOptions[]): LanguageModelV3 {
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

async function storageFor(binding: D1Database) {
  const storage = new D1Store({ id: 'integration-memory', binding, tablePrefix: 'agent_' });
  storage.stores.memory = new D1ObservationalMemory({ binding, tablePrefix: 'agent_' });
  await storage.init();
  return storage;
}

function memoryFor(storage: D1Store, model: LanguageModelV3) {
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

describe('native observational memory on D1', () => {
  it('retains a recent raw-token floor around native manual observation', async () => {
    const binding = sqliteD1Binding(
      join(mkdtempSync(join(tmpdir(), 'walden-native-om-retention-')), 'memory.sqlite'),
    );
    const observerCalls: LanguageModelV3CallOptions[] = [];
    const storage = await storageFor(binding);
    const memory = new Memory({
      storage,
      options: {
        readOnly: true,
        observationalMemory: {
          model: scriptedModel(
            [
              '<observations>\n- Older context was compacted while recent wording remains available.\n</observations>',
            ],
            observerCalls,
          ),
          scope: 'thread',
          observation: { messageTokens: 1_200, bufferTokens: false },
          reflection: { observationTokens: 4_000 },
        },
      },
    });
    const threadId = 'retention-thread';
    const resourceId = 'retention-resource';
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: 'Retention',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const messages = [
      {
        id: 'old-message',
        threadId,
        resourceId,
        role: 'user',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        content: {
          format: 2,
          parts: [{ type: 'text', text: `OLDEST_MARKER ${'old '.repeat(1_400)}` }],
        },
      },
      {
        id: 'recent-message',
        threadId,
        resourceId,
        role: 'assistant',
        createdAt: new Date('2026-01-01T00:01:00Z'),
        content: {
          format: 2,
          parts: [{ type: 'text', text: `NEWEST_MARKER ${'new '.repeat(1_100)}` }],
        },
      },
    ] satisfies Parameters<typeof memory.saveMessages>[0]['messages'];
    await memory.saveMessages({ messages });
    const cycle = await (await memory.omEngine)!.observe({
      threadId,
      resourceId,
      messages: messagesBeforeRecentTokenFloor(memory, messages, 1_000),
    });
    expect(cycle.observed).toBe(true);
    const actorCalls: LanguageModelV3CallOptions[] = [];
    const freshMemory = new Memory({
      storage: await storageFor(binding),
      options: {
        readOnly: true,
        observationalMemory: {
          model: scriptedModel([], []),
          scope: 'thread',
          observation: { messageTokens: 1_200, bufferTokens: false },
          reflection: { observationTokens: 4_000 },
        },
      },
    });
    const actor = new Agent({
      id: 'retention-reader',
      name: 'Retention reader',
      instructions: 'Answer from memory.',
      model: scriptedModel(['Recent wording is still available.'], actorCalls),
      memory: freshMemory,
    });

    await actor.generate('What remains?', {
      memory: { thread: threadId, resource: resourceId, options: { readOnly: true } },
    });

    const actorPrompt = JSON.stringify(actorCalls[0]?.prompt);
    expect(observerCalls).toHaveLength(1);
    expect(actorPrompt).toContain('NEWEST_MARKER');
    expect(actorPrompt).not.toContain('OLDEST_MARKER');
    expect(actorPrompt).toContain('Older context was compacted');
  });

  it('observes, reflects, reloads, and injects observations into a read-only agent run', async () => {
    const binding = sqliteD1Binding(
      join(mkdtempSync(join(tmpdir(), 'walden-native-om-')), 'memory.sqlite'),
    );
    const calls: LanguageModelV3CallOptions[] = [];
    const observerFact = [
      '- User chose the cobalt deployment for the Friday launch because it is reversible.',
      '- Rollback speed is the deciding constraint for the launch.',
      '- The launch decision applies to the production environment.',
      '- Keep the selected deployment unchanged unless the user revises it.',
    ].join('\n');
    const model = scriptedModel(
      [
        `<observations>\n${observerFact}\n</observations>`,
        `<observations>\n- Cobalt is the reversible Friday launch choice.\n</observations>`,
      ],
      calls,
    );
    const storage = await storageFor(binding);
    const memory = memoryFor(storage, model);
    const threadId = 'thread-1';
    const resourceId = 'resource-1';
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: 'Launch',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await memory.saveMessages({
      messages: [
        {
          id: 'message-1',
          threadId,
          resourceId,
          role: 'user',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          content: {
            format: 2,
            parts: [
              {
                type: 'text',
                text: 'Choose cobalt for the Friday launch because rollback is easy. '.repeat(8),
              },
            ],
          },
        },
      ],
    });

    const engine = await memory.omEngine;
    expect(engine).not.toBeNull();
    const cycle = await engine!.observe({ threadId, resourceId });
    expect(cycle).toMatchObject({ observed: true, reflected: true });
    expect(cycle.record.generationCount).toBe(1);

    const freshMemory = memoryFor(await storageFor(binding), scriptedModel([], []));
    const freshEngine = await freshMemory.omEngine;
    const persisted = await freshEngine!.getRecord(threadId, resourceId);
    expect(persisted).toMatchObject({ generationCount: 1 });
    expect(persisted?.activeObservations).toContain('reversible Friday launch');

    const actorCalls: LanguageModelV3CallOptions[] = [];
    const actor = new Agent({
      id: 'reader',
      name: 'Reader',
      instructions: 'Answer from memory.',
      model: scriptedModel(['Cobalt was chosen.'], actorCalls),
      memory: freshMemory,
    });
    await actor.generate('What deployment did I choose?', {
      memory: { thread: threadId, resource: resourceId, options: { readOnly: true } },
    });

    expect(JSON.stringify(actorCalls[0]?.prompt)).toContain('reversible Friday launch');
    expect(calls).toHaveLength(2);
  });
});

const liveAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const liveToken = process.env.CLOUDFLARE_API_TOKEN;
const runLive = process.env.RUN_LIVE_OM === '1' && Boolean(liveAccountId && liveToken);

describe.skipIf(!runLive)('live native observational memory on D1', () => {
  it('persists parseable Gemma observations through a fresh Memory instance', async () => {
    const binding = sqliteD1Binding(
      join(mkdtempSync(join(tmpdir(), 'walden-live-native-om-')), 'memory.sqlite'),
    );
    const storage = await storageFor(binding);
    const model = createCloudflareModel(
      {
        CLOUDFLARE_ACCOUNT_ID: liveAccountId,
        CLOUDFLARE_API_TOKEN: liveToken,
      },
      DEFAULT_AI_MODEL,
    );
    const memory = new Memory({
      storage,
      options: {
        readOnly: true,
        observationalMemory: {
          model,
          scope: 'thread',
          observation: { messageTokens: 200, bufferTokens: false },
          reflection: { observationTokens: 4_000 },
        },
      },
    });
    const threadId = 'live-thread';
    const resourceId = 'live-resource';
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: 'Live OM',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await memory.saveMessages({
      messages: [
        {
          id: 'live-message',
          threadId,
          resourceId,
          role: 'user',
          createdAt: new Date(),
          content: {
            format: 2,
            parts: [
              {
                type: 'text',
                text: 'Remember that my project codename is Juniper Lantern and the launch day is Friday. '.repeat(
                  16,
                ),
              },
            ],
          },
        },
      ],
    });

    const result = await (await memory.omEngine)!.observe({ threadId, resourceId });
    expect(result.observed).toBe(true);
    expect(result.record.activeObservations).toMatch(/Juniper Lantern/i);

    const fresh = new Memory({
      storage: await storageFor(binding),
      options: {
        readOnly: true,
        observationalMemory: {
          model,
          observation: { messageTokens: 200, bufferTokens: false },
          reflection: { observationTokens: 4_000 },
        },
      },
    });
    const persisted = await (await fresh.omEngine)!.getRecord(threadId, resourceId);
    expect(persisted?.activeObservations).toMatch(/Juniper Lantern/i);
    const actor = new Agent({
      id: 'live-memory-reader',
      name: 'Memory reader',
      instructions:
        'Answer briefly from the remembered conversation. Include the exact name and day.',
      model,
      memory: fresh,
    });
    const answer = await actor.generate('What is my project codename and launch day?', {
      memory: { thread: threadId, resource: resourceId, options: { readOnly: true } },
    });
    expect(answer.text).toMatch(/Juniper Lantern/i);
    expect(answer.text).toMatch(/Friday/i);
  }, 90_000);
});
