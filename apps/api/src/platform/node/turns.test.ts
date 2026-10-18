import { uiMessageText } from '@walden/contracts';
import { afterEach, expect, it } from 'vitest';
import { createNodeExecutionHost } from './execution-host';
import { createNodeTurnRouter } from './turns';
import { createTurnFixture, waitForPartial } from './turns-fixtures';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('runs and commits a real compatible-provider turn through the shared Node router/session', async () => {
  const { db, router, calls } = await createTurnFixture(cleanup);
  const response = await router.router.get('turn').stream('turn', 0);
  const text = await response.text();
  expect(text).toContain('Native answer.');
  expect(text).toContain('[DONE]');
  expect(calls()).toBe(1);
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({ status: 'completed', execution_generation: 1 });
  const message = await db
    .prepare("SELECT ui_message FROM messages WHERE id='turn'")
    .first<{ ui_message: string }>();
  expect(uiMessageText(JSON.parse(message!.ui_message))).toBe('Native answer.');
});

it('persists Stop before aborting the actual provider and keeps partial output', async () => {
  const { db, router, setMode } = await createTurnFixture(cleanup);
  setMode('hold');
  const response = await router.router.get('turn').stream('turn', 0);
  const reading = response.text();
  await waitForPartial(db);
  expect(await router.router.get('turn').stop('turn')).toBe(true);
  expect(
    await db.prepare("SELECT request_id FROM turn_cancellations WHERE owner_id='owner'").first(),
  ).toEqual({ request_id: 'request' });
  expect(await db.prepare("SELECT status FROM turns WHERE id='turn'").first()).toEqual({
    status: 'cancelled',
  });
  expect(await reading).toContain('Partial ');
});

it('recovers a native in-flight checkpoint after the Node owner drains and restarts', async () => {
  const { db, env, directory, router, execution, setMode, calls } =
    await createTurnFixture(cleanup);
  setMode('hold');
  const response = await router.router.get('turn').stream('turn', 0);
  const reading = response.text();
  await waitForPartial(db);
  await router.close();
  await reading;
  expect(await db.prepare("SELECT status FROM turns WHERE id='turn'").first()).toEqual({
    status: 'streaming',
  });
  await execution.close();
  setMode('answer');
  const nextHost = await createNodeExecutionHost({ database: db, dataDir: directory });
  cleanup.push(() => nextHost.close());
  const next = createNodeTurnRouter(env, nextHost.host, { execute: true, pollMs: 5 });
  cleanup.push(() => next.close());
  const recovered = await next.router.get('turn').stream('turn', 0);
  const events = await recovered.text();
  expect(events).toContain('data-turn-replace');
  expect(events).toContain('Native answer.');
  expect(calls()).toBe(2);
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({ status: 'completed', execution_generation: 2 });
  const message = await db
    .prepare("SELECT ui_message FROM messages WHERE id='turn'")
    .first<{ ui_message: string }>();
  expect(uiMessageText(JSON.parse(message!.ui_message))).toBe('Native answer.');
}, 30000);
