import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { describe, expect, it } from 'vitest';

import { sqliteD1Binding } from '../d1-test-binding';
import { messagesBeforeRecentTokenFloor } from '../memory';
import { scriptedModel, storageFor } from './fixtures';

async function retentionMemory(
  binding: D1Database,
  observerCalls: Parameters<typeof scriptedModel>[1],
) {
  return new Memory({
    storage: await storageFor(binding),
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
}

function retentionMessages(threadId: string, resourceId: string) {
  return [
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
  ] satisfies Parameters<Memory['saveMessages']>[0]['messages'];
}

describe('native observational memory on D1', () => {
  it('retains a recent raw-token floor around native manual observation', async () => {
    const binding = sqliteD1Binding(
      join(mkdtempSync(join(tmpdir(), 'walden-native-om-retention-')), 'memory.sqlite'),
    );
    const observerCalls: Parameters<typeof scriptedModel>[1] = [];
    const memory = await retentionMemory(binding, observerCalls);
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
    const messages = retentionMessages(threadId, resourceId);
    await memory.saveMessages({ messages });
    const cycle = await (await memory.omEngine)!.observe({
      threadId,
      resourceId,
      messages: messagesBeforeRecentTokenFloor(memory, messages, 1_000),
    });
    expect(cycle.observed).toBe(true);
    const actorCalls: Parameters<typeof scriptedModel>[1] = [];
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
});
