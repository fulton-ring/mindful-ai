import { afterEach, expect, it, vi } from 'vitest';
import * as deletion from '../chat/conversations/deletion';
import * as retention from '../chat/conversations/retention';
import * as scheduling from '../chat/turns/scheduling';
import * as privacy from '../execution/privacy';
import worker from '../index';
import * as telemetry from '../privacy/content-telemetry';
import type { Bindings } from '../types';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const sync = vi.spyOn(retention, 'syncRetentionPolicies').mockResolvedValue();
  const sweep = vi.spyOn(privacy, 'sweepCloudflareExecutions').mockResolvedValue();
  const reconcile = vi.spyOn(scheduling, 'reconcileTurns').mockResolvedValue();
  const purge = vi.spyOn(deletion, 'purgeExpiredConversations').mockResolvedValue(0);
  vi.spyOn(telemetry, 'purgeTelemetry').mockResolvedValue();
  const tasks: Promise<unknown>[] = [];
  const run = async () => {
    await worker.scheduled(
      { cron: '17 * * * *' } as ScheduledController,
      {} as Bindings,
      {
        waitUntil: (task: Promise<unknown>) => {
          tasks.push(task);
        },
      } as unknown as ExecutionContext,
    );
    return Promise.all(tasks);
  };
  return { sync, sweep, reconcile, purge, run };
}

it('synchronizes changed retention policy before any scheduled execution cleanup', async () => {
  const { sync, sweep, reconcile, purge, run } = fixture();
  let release!: () => void;
  sync.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const task = run();
  expect(sync).toHaveBeenCalledOnce();
  expect(sweep).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  expect(purge).not.toHaveBeenCalled();
  release();
  await task;
  expect(sweep).toHaveBeenCalledOnce();
  expect(reconcile).toHaveBeenCalledOnce();
  expect(purge).toHaveBeenCalledOnce();
});

it('defers cleanup if current entitlements cannot be resolved', async () => {
  const { sync, sweep, reconcile, purge, run } = fixture();
  sync.mockRejectedValue(new Error('provider unavailable'));
  await expect(run()).rejects.toThrow('provider unavailable');
  expect(sweep).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  expect(purge).not.toHaveBeenCalled();
});
