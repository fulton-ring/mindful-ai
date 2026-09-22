import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { describe, expect, it } from 'vitest';

import { sqliteD1Binding } from './d1-test-binding';
import { memoryFor, scriptedModel, storageFor } from './memory-integration-fixtures';

async function setupObservation(binding: D1Database, calls: Parameters<typeof scriptedModel>[1]) {
  const observerFact = [
    '- User chose the cobalt deployment for the Friday launch because it is reversible.',
    '- Rollback speed is the deciding constraint for the launch.',
    '- The launch decision applies to the production environment.',
    '- Keep the selected deployment unchanged unless the user revises it.',
  ].join('\n');
  const model = scriptedModel(
    [
      `<observations>\n${observerFact}\n</observations>`,
      '<observations>\n- Cobalt is the reversible Friday launch choice.\n</observations>',
    ],
    calls,
  );
  const memory = memoryFor(await storageFor(binding), model);
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
  return { memory, threadId, resourceId };
}

describe('native observational memory on D1', () => {
  it('observes, reflects, reloads, and injects observations into a read-only agent run', async () => {
    const binding = sqliteD1Binding(
      join(mkdtempSync(join(tmpdir(), 'walden-native-om-')), 'memory.sqlite'),
    );
    const calls: Parameters<typeof scriptedModel>[1] = [];
    const { memory, threadId, resourceId } = await setupObservation(binding, calls);

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

    const actorCalls: Parameters<typeof scriptedModel>[1] = [];
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
