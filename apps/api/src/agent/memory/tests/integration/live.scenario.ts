import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { describe, expect, it } from 'vitest';

import { createCloudflareModel, DEFAULT_AI_MODEL } from '../../../../services/agent/agent';
import { sqliteD1Binding } from '../d1-test-binding';
import { storageFor } from './fixtures';

const liveAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const liveToken = process.env.CLOUDFLARE_API_TOKEN;
const runLive = process.env.RUN_LIVE_OM === '1' && Boolean(liveAccountId && liveToken);

async function saveLiveConversation(memory: Memory, threadId: string, resourceId: string) {
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
}

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
    await saveLiveConversation(memory, threadId, resourceId);

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
