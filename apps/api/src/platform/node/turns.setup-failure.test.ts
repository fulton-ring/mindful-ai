import type { WaldenUIMessageChunk } from '@walden/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnSession } from '../../chat/turns/turn-session';
import { completeTurn, loadTurn } from '../../chat/turns/turn-store';
import type { ObjectStore } from '../../storage/object-store';
import { SQLTurnStorage } from './turn-storage';
import { createTurnFixture } from './turns-fixtures';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function setupFailure() {
  const fixture = await createTurnFixture(cleanup);
  const input = await fixture.db
    .prepare("SELECT input_json FROM turns WHERE id='turn'")
    .first<{ input_json: string }>();
  await fixture.db
    .prepare("UPDATE turns SET input_json=? WHERE id='turn'")
    .bind(JSON.stringify({ ...JSON.parse(input!.input_json), attachments: [{ id: 'file' }] }))
    .run();
  const get = vi.fn(async () => {
    throw new Error('Transient S3 outage on worker B');
  });
  const files: ObjectStore = {
    get,
    head: async () => null,
    put: async () => null,
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
  };
  const session = new TurnSession(
    { ...fixture.env, FILES: files },
    new SQLTurnStorage(fixture.db, 'turn'),
    (task) => void task.catch(() => undefined),
    fixture.execution.host,
  );
  cleanup.push(() => session.drain());
  return { ...fixture, session, get };
}

it('does not let a contender setup failure finalize the healthy native owner generation', async () => {
  const { db, execution, session, get, calls } = await setupFailure();
  await db.prepare("UPDATE turns SET execution_generation=1 WHERE id='turn'").run();
  const now = Date.now();
  await new SQLTurnStorage(db, 'turn').begin('turn', {
    version: 1,
    startedAt: now,
    deadlineAt: now + 900_000,
    model: 'fixture-model',
    generation: 1,
  });
  const workflows = (await execution.host.storage.getStore('workflows'))!;
  const claim = await workflows.claimRunOwnership({
    runId: 'turn',
    ownerId: 'healthy-worker-A',
    leaseMs: 30_000,
  });
  expect(claim.acquired).toBe(true);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await session.start('turn');
  await expect.poll(() => get.mock.calls.length).toBe(1);
  await expect
    .poll(() => warning.mock.calls.some(([text]) => text === 'Turn recovery deferred'))
    .toBe(true);
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({
    status: 'streaming',
    execution_generation: 1,
  });
  expect((await workflows.getRunOwnership({ runId: 'turn' }))?.ownerId).toBe('healthy-worker-A');
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM turn_events WHERE turn_id='turn'").first(),
  ).toEqual({ n: 0 });
  expect(calls()).toBe(0);
});

it('claims native and application ownership before promptly finalizing a sole worker setup failure', async () => {
  const { db, execution, session, calls } = await setupFailure();
  const response = await session.stream('turn', 0);
  await response.text();
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({
    status: 'failed',
    execution_generation: 1,
  });
  const workflows = (await execution.host.storage.getStore('workflows'))!;
  expect((await workflows.getRunOwnership({ runId: 'turn' }))?.live).toBe(false);
  expect(calls()).toBe(0);
});

it('settles a durable Stop recorded before any worker claims the turn', async () => {
  const { db, session, calls } = await setupFailure();
  await db
    .prepare('INSERT INTO turn_cancellations(owner_id,request_id,created_at) VALUES(?,?,?)')
    .bind('owner', 'request', new Date().toISOString())
    .run();
  const response = await session.stream('turn', 0);
  await expect
    .poll(() => db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first())
    .toEqual({
      status: 'cancelled',
      execution_generation: 1,
    });
  expect(await response.text()).toContain('Turn cancelled');
  expect(calls()).toBe(0);
});

it('settles preclaim Stop when native setup reaches the rejected execution claim', async () => {
  const { db, env, execution, calls } = await createTurnFixture(cleanup);
  await db
    .prepare('INSERT INTO turn_cancellations(owner_id,request_id,created_at) VALUES(?,?,?)')
    .bind('owner', 'request', new Date().toISOString())
    .run();
  const session = new TurnSession(env, new SQLTurnStorage(db, 'turn'), () => {}, execution.host);
  cleanup.push(() => session.drain());
  const response = await session.stream('turn', 0);
  await expect
    .poll(() => db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first())
    .toEqual({
      status: 'cancelled',
      execution_generation: 1,
    });
  expect(await response.text()).toContain('Turn cancelled');
  expect(calls()).toBe(0);
});

it('replays a committed reply successfully after a crash before terminal event persistence', async () => {
  const { db, env, execution, calls } = await createTurnFixture(cleanup);
  const storage = new SQLTurnStorage(db, 'turn');
  await storage.begin('turn');
  const chunks: WaldenUIMessageChunk[] = [
    { type: 'start', messageId: 'turn' },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: 'Committed answer.' },
    { type: 'text-end', id: 'text' },
  ];
  for (const [index, chunk] of chunks.entries()) await storage.append(index + 1, chunk);
  expect(await completeTurn(db, (await loadTurn(db, 'turn'))!, chunks)).not.toBeNull();
  const session = new TurnSession(env, new SQLTurnStorage(db, 'turn'), () => {}, execution.host);
  cleanup.push(() => session.drain());
  const response = await session.stream('turn', 0);
  const text = await response.text();
  expect(text).toContain('Committed answer.');
  expect(text).toContain('"finishReason":"stop"');
  expect(text).toContain('"status":"complete"');
  expect(text).not.toContain('"type":"error"');
  expect((await new SQLTurnStorage(db, 'turn').state())?.endedAt).toBeDefined();
  expect(calls()).toBe(0);
});
