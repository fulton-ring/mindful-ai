import { Agent } from '@mastra/core/agent';
import { InMemoryServerCache } from '@mastra/core/cache';
import { LibSQLStore } from '@mastra/libsql';
import { describe, expect, it } from 'vitest';
import { deterministicModel } from './fixture-model';
import { nativeAgentStream } from './native-agent';

describe('shared native agent', () => {
  it('executes the actual native durable workflow using injected storage', async () => {
    const storage = new LibSQLStore({ id: 'native-test', url: ':memory:' });
    await storage.init();
    const agent = new Agent({
      id: 'native-test',
      name: 'Native test',
      instructions: 'Answer.',
      model: deterministicModel(),
    });
    const run = await nativeAgentStream(
      agent,
      'Hello',
      {},
      {
        host: { storage, cache: new InMemoryServerCache() },
        runId: 'turn-test',
        recover: false,
        generation: 1,
      },
    );
    expect(await run.output.text).toBe('Native answer.');
    await run.release();
    await storage.close();
  });
});

it('releasing one turn leaves shared host storage usable for another turn', async () => {
  const storage = new LibSQLStore({ id: 'native-shared', url: ':memory:' });
  await storage.init();
  const host = { storage, cache: new InMemoryServerCache() };
  for (const runId of ['first-turn', 'second-turn']) {
    const agent = new Agent({
      id: 'shared-agent',
      name: 'Shared',
      instructions: 'Answer.',
      model: deterministicModel(),
    });
    const run = await nativeAgentStream(
      agent,
      'Hello',
      {},
      { host, runId, recover: false, generation: 1 },
    );
    expect(await run.output.text).toBe('Native answer.');
    await run.release();
  }
  await storage.close();
});

it('reconstructs a completed learning-check proposal without another model or tool call', async () => {
  const { streamMastraTurn } = await import('../agent/mastra-turn');
  const { researchModel, turnInput } = await import('../agent/tests/fixtures/research-tools');
  const storage = new LibSQLStore({ id: 'native-proposal', url: ':memory:' });
  await storage.init();
  const host = { storage, cache: new InMemoryServerCache() };
  const calls: import('@ai-sdk/provider').LanguageModelV3CallOptions[] = [];
  const input = turnInput();
  input.conversation.learningChecksEnabled = true;
  const model = researchModel(calls, false, true);
  const collect = async (recover: boolean) => {
    const chunks = [];
    for await (const chunk of streamMastraTurn({
      input,
      model,
      signal: new AbortController().signal,
      runtime: { execution: { host, runId: input.turnId, generation: 1, recover } },
    }))
      chunks.push(chunk);
    return chunks;
  };
  const first = await collect(false);
  expect(calls).toHaveLength(1);
  const proposal = first.find((chunk) => chunk.type === 'data-intervention');
  expect(proposal).toBeDefined();
  const replay = await collect(true);
  expect(calls).toHaveLength(1);
  expect(replay.find((chunk) => chunk.type === 'data-intervention')).toEqual(proposal);
  await storage.close();
});
