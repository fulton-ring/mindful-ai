import { afterEach, expect, it, vi } from 'vitest';
import { TurnSession } from '../../chat/turns/turn-session';
import { type Cleanup, createTurnFixture } from './turns-fixtures';

const cleanup: Cleanup[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  const context = await createTurnFixture(cleanup);
  const alarm = vi.spyOn(TurnSession.prototype, 'alarm').mockResolvedValue();
  const start = vi.spyOn(TurnSession.prototype, 'start').mockResolvedValue();
  await context.db
    .prepare(
      'INSERT INTO turn_execution_state(turn_id,state_json,alarm_at) VALUES(\'turn\',\'{"turnId":"turn"}\',?)',
    )
    .bind(Date.now() - 1)
    .run();
  return { ...context, alarm, start };
}

it('awaits current entitlements before due alarms or recovery can inspect old expiry', async () => {
  const { db, env, router, alarm, start } = await fixture();
  let release!: (plan: string) => void;
  const plan = new Promise<string>((resolve) => {
    release = resolve;
  });
  const getPlan = vi.fn(() => plan);
  env.ENTITLEMENTS = { getPlan };
  env.APP_PLANS_JSON = JSON.stringify({ team: { retention: { idleDays: null } } });
  const scanning = router.scan();
  try {
    await vi.waitFor(() => expect(getPlan).toHaveBeenCalledOnce());
    expect(alarm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  } finally {
    release('team');
    await scanning;
  }
  expect(
    await db.prepare('SELECT retention_disabled FROM conversations').first('retention_disabled'),
  ).toBe(1);
  expect(alarm).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});

it('refreshes entitlements once per prune interval rather than on every scan', async () => {
  const { env, router } = await fixture();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const getPlan = vi.fn().mockResolvedValue(null);
  env.ENTITLEMENTS = { getPlan };
  await router.scan();
  await router.scan();
  now += 59_999;
  await router.scan();
  expect(getPlan).toHaveBeenCalledOnce();
  now++;
  await router.scan();
  expect(getPlan).toHaveBeenCalledTimes(2);
});

it('blocks recovery after a failed refresh until the next interval succeeds', async () => {
  const { env, router, alarm, start } = await fixture();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const getPlan = vi.fn().mockRejectedValue(new Error('Provider unavailable'));
  env.ENTITLEMENTS = { getPlan };
  await expect(router.scan()).rejects.toMatchObject({ status: 503 });
  await expect(router.scan()).rejects.toMatchObject({ status: 503 });
  expect(alarm).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(getPlan).toHaveBeenCalledOnce();
  now += 60_000;
  getPlan.mockResolvedValue(null);
  await router.scan();
  expect(getPlan).toHaveBeenCalledTimes(2);
  expect(alarm).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});
