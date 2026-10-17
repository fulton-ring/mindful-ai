import { Agent } from '@mastra/core/agent';
import { InMemoryServerCache } from '@mastra/core/cache';
import { LibSQLStore } from '@mastra/libsql';
import { expect, it, vi } from 'vitest';
import { deterministicModel } from './fixture-model';
import { type NativeExecutionContext, nativeAgentStream } from './native-agent';

it('admits one terminal replay claimant and holds ownership through application finalization', async () => {
  const storage = new LibSQLStore({ id: 'terminal-race', url: ':memory:' });
  await storage.init();
  const host = { storage, cache: new InMemoryServerCache() };
  const agent = () =>
    new Agent({
      id: 'terminal-race',
      name: 'Terminal race',
      instructions: 'Answer.',
      model: deterministicModel(),
    });
  const context = (onClaim?: () => Promise<void>): NativeExecutionContext => ({
    host,
    runId: 'completed-native-run',
    recover: true,
    generation: 1,
    onClaim,
  });
  let releaseClaim!: () => void;
  let enteredClaim!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredClaim = resolve;
  });
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const firstContext = context(async () => {
    enteredClaim();
    await claimGate;
  });
  const secondClaim = vi.fn(async () => {});
  const secondContext = context(secondClaim);
  let replay: Awaited<ReturnType<typeof nativeAgentStream>> | undefined;
  try {
    const first = await nativeAgentStream(agent(), 'Hello', {}, { ...context(), recover: false });
    expect(await first.output.text).toBe('Native answer.');
    await first.release();
    const recovering = nativeAgentStream(agent(), 'Hello', {}, firstContext);
    await entered;
    try {
      await expect(nativeAgentStream(agent(), 'Hello', {}, secondContext)).rejects.toMatchObject({
        id: 'DURABLE_AGENT_RUN_ACTIVE',
      });
      expect(secondClaim).not.toHaveBeenCalled();
    } finally {
      releaseClaim();
      replay = await recovering;
    }
    expect(await replay.output.text).toBe('Native answer.');
    await replay.release();
    const workflows = (await storage.getStore('workflows'))!;
    expect((await workflows.getRunOwnership({ runId: firstContext.runId }))?.live).toBe(true);
    await firstContext.releaseOwnership?.();
    expect((await workflows.getRunOwnership({ runId: firstContext.runId }))?.live).toBe(false);
  } finally {
    releaseClaim();
    await replay?.release();
    await firstContext.releaseOwnership?.();
    await secondContext.releaseOwnership?.();
    await storage.close();
  }
}, 20_000);
