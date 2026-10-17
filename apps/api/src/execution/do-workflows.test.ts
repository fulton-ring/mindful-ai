import type { WorkflowRunState } from '@mastra/core/workflows';
import { describe, expect, it } from 'vitest';
import { DoWorkflowsStorage } from './do-workflows';
import { sqliteStorage } from './do-workflows-test-helper';

const snapshot = (runId = 'run'): WorkflowRunState => ({
  runId,
  status: 'running',
  context: {},
  value: {},
  serializedStepGraph: [],
  activePaths: [],
  activeStepsPath: {},
  suspendedPaths: {},
  resumeLabels: {},
  waitingPaths: {},
  timestamp: 1,
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: grouped storage conformance cases
describe('DO workflow SQLite storage', () => {
  it('merges concurrent step writes and workflow state without losing results', async () => {
    const storage = sqliteStorage();
    const store = new DoWorkflowsStorage({ storage });
    await store.persistWorkflowSnapshot({
      workflowName: 'flow',
      runId: 'run',
      snapshot: snapshot(),
      resourceId: 'user',
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.updateWorkflowResults({
          workflowName: 'flow',
          runId: 'run',
          stepId: `s${i}`,
          result: { status: 'success', payload: {}, startedAt: 1, endedAt: 2, output: i },
          requestContext: { [`k${i}`]: i },
          state: { latest: i },
        }),
      ),
    );
    const result = await store.loadWorkflowSnapshot({ workflowName: 'flow', runId: 'run' });
    expect(Object.keys(result!.context)).toHaveLength(21);
    expect(result!.requestContext).toHaveProperty('k0', 0);
    expect(result!.context.__state).toEqual({ latest: 19 });
    const claims = await Promise.all(
      ['success', 'failed'].map((status) =>
        store.updateWorkflowState({
          workflowName: 'flow',
          runId: 'run',
          opts: { status: status as 'success', expectedStatus: 'running' },
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await new DoWorkflowsStorage({ storage }).loadWorkflowSnapshot({
        workflowName: 'flow',
        runId: 'run',
      }),
    ).toMatchObject({ status: 'success' });
    expect((await store.listWorkflowRuns({ resourceId: 'user', status: 'success' })).total).toBe(1);
    expect(
      await store.updateWorkflowResults({
        workflowName: 'flow',
        runId: 'missing',
        stepId: 's',
        result: { status: 'success', payload: {}, startedAt: 1, endedAt: 2, output: 1 },
        requestContext: {},
      }),
    ).toEqual({});
  });

  it('atomically fences all stale writes, preserving released-owner late writes until takeover', async () => {
    const store = new DoWorkflowsStorage({ storage: sqliteStorage() });
    const first = await store.claimRunOwnership({
      runId: 'run',
      ownerId: 'first',
      leaseMs: 1000,
      expectedGeneration: 0,
    });
    expect(first.acquired).toBe(true);
    const fence = { runId: 'run', ownerId: 'first', generation: first.record!.generation };
    expect(
      (await store.claimRunOwnership({ runId: 'run', ownerId: 'other', leaseMs: 1000 })).acquired,
    ).toBe(false);
    expect(await store.releaseRunOwnership(fence)).toBe(true);
    await store.persistWorkflowSnapshot({
      workflowName: 'flow',
      runId: 'run',
      snapshot: snapshot(),
      fence,
    });
    const second = await store.claimRunOwnership({
      runId: 'run',
      ownerId: 'second',
      leaseMs: 1000,
      expectedGeneration: fence.generation,
    });
    expect(second.record!.generation).toBe(fence.generation + 1);
    for (const write of [
      () =>
        store.persistWorkflowSnapshot({
          workflowName: 'flow',
          runId: 'run',
          snapshot: snapshot(),
          fence,
        }),
      () =>
        store.updateWorkflowResults({
          workflowName: 'flow',
          runId: 'run',
          stepId: 'bad',
          result: { status: 'success', payload: {}, startedAt: 1, endedAt: 2, output: 1 },
          requestContext: {},
          fence,
        }),
      () =>
        store.updateWorkflowState({
          workflowName: 'flow',
          runId: 'run',
          opts: { status: 'failed' },
          fence,
        }),
      () => store.deleteWorkflowRunById({ workflowName: 'flow', runId: 'run', fence }),
    ])
      await expect(write()).rejects.toMatchObject({ id: 'STORAGE_RUN_FENCE_CONFLICT' });
    expect((await store.renewRunOwnership({ ...fence, leaseMs: 1000 })).renewed).toBe(false);
    expect(await store.loadWorkflowSnapshot({ workflowName: 'flow', runId: 'run' })).toMatchObject({
      status: 'running',
      context: {},
    });
  });
});

it('keeps generations monotonic through expiry, renewal, forced races and release', async () => {
  const store = new DoWorkflowsStorage({ storage: sqliteStorage() });
  const before = Date.now();
  const first = await store.claimRunOwnership({ runId: 'lease', ownerId: 'owner', leaseMs: -1 });
  const fence = { runId: 'lease', generation: first.record!.generation, ownerId: 'owner' };
  expect(fence.generation).toBeGreaterThanOrEqual(before);
  expect(first.record!.live).toBe(false);
  expect((await store.renewRunOwnership({ ...fence, leaseMs: 10000 })).renewed).toBe(true);
  const failed = await store.claimRunOwnership({
    runId: 'lease',
    ownerId: 'new',
    force: true,
    expectedGeneration: 0,
    leaseMs: 1000,
  });
  expect(failed.acquired).toBe(false);
  expect(await store.releaseRunOwnership(fence)).toBe(true);
  expect((await store.renewRunOwnership({ ...fence, leaseMs: 1000 })).renewed).toBe(false);
  const races = await Promise.all(
    ['a', 'b'].map((ownerId) =>
      store.claimRunOwnership({
        runId: 'lease',
        ownerId,
        force: true,
        expectedGeneration: fence.generation,
        leaseMs: 1000,
      }),
    ),
  );
  expect(races.filter((result) => result.acquired)).toHaveLength(1);
  expect((await store.getRunOwnership({ runId: 'lease' }))!.generation).toBe(fence.generation + 1);
});

it('atomically merges foreach result slots instead of dropping other completed iterations', async () => {
  const store = new DoWorkflowsStorage({ storage: sqliteStorage() });
  await store.persistWorkflowSnapshot({ workflowName: 'flow', runId: 'run', snapshot: snapshot() });
  for (const output of [
    [1, null],
    [null, 2],
  ])
    await store.updateWorkflowResults({
      workflowName: 'flow',
      runId: 'run',
      stepId: 'each',
      result: { status: 'success', payload: {}, startedAt: 1, endedAt: 2, output },
      requestContext: {},
    });
  expect(
    (await store.loadWorkflowSnapshot({ workflowName: 'flow', runId: 'run' }))!.context.each,
  ).toMatchObject({ output: [1, 2] });
});
