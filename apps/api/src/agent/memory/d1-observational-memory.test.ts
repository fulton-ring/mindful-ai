import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { D1ObservationalMemory } from './d1-observational-memory';
import { sqliteD1Binding } from './d1-test-binding';

const setup = async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-om-')), 'memory.sqlite');
  const binding = sqliteD1Binding(file);
  const storage = new D1ObservationalMemory({ binding, tablePrefix: 'agent_' });
  await storage.init();
  await storage.saveThread({
    thread: {
      id: 'thread-1',
      resourceId: 'resource-1',
      title: 'Thread',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  return { binding, storage };
};

it('retries competing cross-instance buffer appends and config merges without losing either write', async () => {
  const { binding, storage } = await setup();
  const other = new D1ObservationalMemory({ binding, tablePrefix: 'agent_' });
  const record = await storage.initializeObservationalMemory({
    threadId: 'thread-1',
    resourceId: 'resource-1',
    scope: 'thread',
    config: { stable: true },
  });
  const chunk = (cycleId: string) => ({
    cycleId,
    observations: cycleId,
    tokenCount: 1,
    messageIds: [`message-${cycleId}`],
    messageTokens: 2,
    lastObservedAt: new Date('2026-01-01T01:00:00Z'),
  });

  await Promise.all([
    storage.updateBufferedObservations({ id: record.id, chunk: chunk('one') }),
    other.updateBufferedObservations({ id: record.id, chunk: chunk('two') }),
    storage.updateObservationalMemoryConfig({ id: record.id, config: { first: { value: 1 } } }),
    other.updateObservationalMemoryConfig({ id: record.id, config: { second: { value: 2 } } }),
  ]);

  const loaded = await other.getObservationalMemory('thread-1', 'resource-1');
  expect(loaded?.bufferedObservationChunks?.map(({ cycleId }) => cycleId).sort()).toEqual([
    'one',
    'two',
  ]);
  expect(loaded?.config).toEqual({ stable: true, first: { value: 1 }, second: { value: 2 } });
});

it('persists the native record shape and appends each buffered cycle only once', async () => {
  const { storage } = await setup();
  const record = await storage.initializeObservationalMemory({
    threadId: 'thread-1',
    resourceId: 'resource-1',
    scope: 'thread',
    config: { nested: { original: true } },
    observedTimezone: 'America/New_York',
  });
  const chunk = {
    cycleId: 'cycle-1',
    observations: 'User likes quiet mornings.',
    tokenCount: 6,
    messageIds: ['message-1'],
    messageTokens: 12,
    lastObservedAt: new Date('2026-01-01T01:00:00Z'),
  };
  await storage.updateBufferedObservations({ id: record.id, chunk });
  await storage.updateBufferedObservations({ id: record.id, chunk });
  await storage.updateObservationalMemoryConfig({
    id: record.id,
    config: { nested: { added: true } },
  });

  const loaded = await storage.getObservationalMemory('thread-1', 'resource-1');
  expect(loaded).toMatchObject({
    id: record.id,
    scope: 'thread',
    bufferedObservationChunks: [{ cycleId: 'cycle-1', observations: chunk.observations }],
    config: { nested: { original: true, added: true } },
    observedTimezone: 'America/New_York',
  });
  expect(loaded?.bufferedObservationChunks?.[0]?.createdAt).toBeInstanceOf(Date);

  await storage.setPendingMessageTokens(record.id, 12);
  const staleSnapshot = loaded!.bufferedObservationChunks!;
  const firstSwap = await storage.swapBufferedToActive({
    id: record.id,
    activationRatio: 1,
    messageTokensThreshold: 12,
    currentPendingTokens: 12,
    bufferedChunks: staleSnapshot,
  });
  const staleRetry = await storage.swapBufferedToActive({
    id: record.id,
    activationRatio: 1,
    messageTokensThreshold: 12,
    currentPendingTokens: 12,
    bufferedChunks: staleSnapshot,
  });
  expect(firstSwap.chunksActivated).toBe(1);
  expect(staleRetry.chunksActivated).toBe(0);
  expect((await storage.getObservationalMemory('thread-1', 'resource-1'))?.activeObservations).toBe(
    chunk.observations,
  );
});

it('keeps reflection generations as history and deletes every generation with the thread', async () => {
  const { storage } = await setup();
  const initial = await storage.initializeObservationalMemory({
    threadId: 'thread-1',
    resourceId: 'resource-1',
    scope: 'thread',
    config: {},
  });
  await storage.updateActiveObservations({
    id: initial.id,
    observations: 'Initial observation',
    tokenCount: 3,
    lastObservedAt: new Date('2026-01-02T00:00:00Z'),
  });
  const current = (await storage.getObservationalMemory('thread-1', 'resource-1'))!;
  const reflected = await storage.createReflectionGeneration({
    currentRecord: current,
    reflection: 'Reflected observation',
    tokenCount: 2,
  });

  expect(reflected.generationCount).toBe(1);
  expect(
    (await storage.getObservationalMemoryHistory('thread-1', 'resource-1')).map((row) => row.id),
  ).toEqual([reflected.id, initial.id]);

  await storage.deleteThread({ threadId: 'thread-1' });
  expect(await storage.getObservationalMemoryHistory('thread-1', 'resource-1')).toEqual([]);
});

it('atomically swaps a buffered reflection while retaining observations appended after reflection began', async () => {
  const { storage } = await setup();
  const initial = await storage.initializeObservationalMemory({
    threadId: 'thread-1',
    resourceId: 'resource-1',
    scope: 'thread',
    config: {},
  });
  await storage.updateActiveObservations({
    id: initial.id,
    observations: 'old line one\nold line two',
    tokenCount: 6,
    lastObservedAt: new Date('2026-01-02T00:00:00Z'),
  });
  await storage.updateBufferedReflection({
    id: initial.id,
    reflection: 'compressed old lines',
    tokenCount: 3,
    inputTokenCount: 6,
    reflectedObservationLineCount: 2,
  });
  await storage.updateActiveObservations({
    id: initial.id,
    observations: 'old line one\nold line two\nnew unreflected line',
    tokenCount: 10,
    lastObservedAt: new Date('2026-01-03T00:00:00Z'),
  });
  const beforeSwap = (await storage.getObservationalMemory('thread-1', 'resource-1'))!;
  const reflected = await storage.swapBufferedReflectionToActive({
    currentRecord: beforeSwap,
    tokenCount: 7,
  });

  expect(reflected.activeObservations).toBe('compressed old lines\n\nnew unreflected line');
  expect(reflected.generationCount).toBe(1);
  const old = (await storage.getObservationalMemoryHistory('thread-1', 'resource-1')).at(-1);
  expect(old).toMatchObject({
    id: initial.id,
    bufferedReflection: undefined,
    reflectedObservationLineCount: undefined,
  });
});

it('rejects stale post-deletion writes and initialization without a live parent thread', async () => {
  const { storage } = await setup();
  const record = await storage.initializeObservationalMemory({
    threadId: 'thread-1',
    resourceId: 'resource-1',
    scope: 'thread',
    config: {},
  });
  await storage.deleteThread({ threadId: 'thread-1' });

  await expect(storage.setPendingMessageTokens(record.id, 42)).rejects.toThrow('not found');
  await expect(
    storage.initializeObservationalMemory({
      threadId: 'thread-1',
      resourceId: 'resource-1',
      scope: 'thread',
      config: {},
    }),
  ).rejects.toThrow('missing thread');
});
