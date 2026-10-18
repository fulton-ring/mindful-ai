import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { expect, it } from 'vitest';
import { deterministicModel } from '../../execution/fixture-model';
import { nativeAgentStream } from '../../execution/native-agent';
import { openSqliteDatabase } from './sqlite';

const factory = await import('./execution-host').catch(() => null);
it('persists native workflow checkpoints and cache across SQLite host restarts', async () => {
  expect(factory?.createNodeExecutionHost).toBeTypeOf('function');
  const dataDir = await mkdtemp(join(tmpdir(), 'walden-host-'));
  const database = openSqliteDatabase(join(dataDir, 'application.sqlite'));
  try {
    const runtime = await factory!.createNodeExecutionHost({ database, dataDir });
    await runtime.ready();
    const agent = new Agent({
      id: 'host-test',
      name: 'Host test',
      instructions: 'Answer.',
      model: deterministicModel(),
    });
    const run = await nativeAgentStream(
      agent,
      'Hello',
      {},
      { host: runtime.host, runId: 'host-run', recover: false, generation: 1 },
    );
    expect(await run.output.text).toBe('Native answer.');
    await run.release();
    const workflows = await runtime.host.storage.getStore('workflows');
    await workflows!.persistWorkflowSnapshot({
      workflowName: 'host-checkpoint',
      runId: 'pending-run',
      snapshot: { status: 'pending' } as never,
    });
    await runtime.host.cache.set('survives-restart', { value: 3 });
    await runtime.close();
    const restored = await factory!.createNodeExecutionHost({ database, dataDir });
    expect(await restored.host.cache.get('survives-restart')).toEqual({ value: 3 });
    expect(
      await (await restored.host.storage.getStore('workflows'))?.loadWorkflowSnapshot({
        workflowName: 'host-checkpoint',
        runId: 'pending-run',
      }),
    ).toMatchObject({ status: 'pending' });
    await restored.close();
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
