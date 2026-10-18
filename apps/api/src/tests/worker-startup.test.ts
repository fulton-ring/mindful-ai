import { expect, it, vi } from 'vitest';
import type { Bindings } from '../types';

const runtime = vi.hoisted(() => ({
  loaded: [] as string[],
  fetch: vi.fn(() => new Response('ready')),
  scheduled: vi.fn(),
  start: vi.fn(),
  stream: vi.fn(() => new Response('stream')),
  stop: vi.fn(() => true),
  alarm: vi.fn(),
  sessions: vi.fn(),
  migrate: vi.fn(async () => {}),
}));

vi.mock('../db/d1-startup', () => ({ ensureD1Schema: runtime.migrate }));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: DurableObjectState,
      protected env: Bindings,
    ) {}
  },
}));
vi.mock('../index', () => {
  runtime.loaded.push('http');
  return { default: { fetch: runtime.fetch, scheduled: runtime.scheduled } };
});
vi.mock('../chat/turns/turn-session', () => {
  runtime.loaded.push('turn');
  return {
    TurnSession: class {
      constructor() {
        runtime.sessions();
      }
      start = runtime.start;
      stream = runtime.stream;
      stop = runtime.stop;
      alarm = runtime.alarm;
    },
  };
});

it('loads application runtimes on events, outside Worker startup, and shares each turn session', async () => {
  const { default: worker, ChatTurn } = await import('../worker');
  expect(runtime.loaded).toEqual([]);

  const env = {} as Bindings;
  const ctx = {} as ExecutionContext;
  const request = new Request('https://chat.withwalden.app/api/config') as Parameters<
    typeof worker.fetch
  >[0];
  expect(await worker.fetch(request, env, ctx)).toBeInstanceOf(Response);
  expect(runtime.fetch).toHaveBeenCalledWith(request, env, ctx);
  const controller = { cron: '* * * * *' } as ScheduledController;
  await worker.scheduled(controller, env, ctx);
  expect(runtime.scheduled).toHaveBeenCalledWith(controller, env, ctx);
  expect(runtime.loaded).toEqual(['http']);

  const state = { storage: { sql: { exec: vi.fn(() => []) } } } as unknown as DurableObjectState;
  const turn = new ChatTurn(state, env);
  await Promise.all([turn.start('turn-id'), turn.stream('turn-id', 5)]);
  expect(await turn.stop('turn-id')).toBe(true);
  await turn.alarm();
  expect(runtime.loaded).toEqual(['http', 'turn']);
  expect(runtime.sessions).toHaveBeenCalledOnce();
  expect(runtime.start).toHaveBeenCalledWith('turn-id');
  expect(runtime.stream).toHaveBeenCalledWith('turn-id', 5);
  expect(runtime.stop).toHaveBeenCalledWith('turn-id');
  expect(runtime.alarm).toHaveBeenCalledOnce();
});

it('waits for schema readiness and retries HTTP and scheduled startup failures', async () => {
  const { default: worker } = await import('../worker');
  const env = {} as Bindings,
    ctx = {} as ExecutionContext;
  const request = new Request('https://example.com/api/config') as Parameters<
    typeof worker.fetch
  >[0];
  runtime.migrate.mockRejectedValueOnce(new Error('temporary database failure'));
  expect((await worker.fetch(request, env, ctx)).status).toBe(503);
  let ready = false;
  runtime.migrate.mockImplementationOnce(async () => {
    await Promise.resolve();
    ready = true;
  });
  runtime.fetch.mockImplementationOnce(() => {
    expect(ready).toBe(true);
    return new Response('ready');
  });
  expect((await worker.fetch(request, env, ctx)).status).toBe(200);
  const controller = { cron: '* * * * *' } as ScheduledController;
  runtime.migrate.mockRejectedValueOnce(new Error('temporary database failure'));
  await expect(worker.scheduled(controller, env, ctx)).rejects.toThrow(
    'temporary database failure',
  );
  await worker.scheduled(controller, env, ctx);
});

it('retries a failed Durable Object bootstrap without constructing a session too early', async () => {
  const { ChatTurn } = await import('../worker');
  const state = { storage: { sql: { exec: vi.fn(() => []) } } } as unknown as DurableObjectState;
  const before = runtime.sessions.mock.calls.length;
  const turn = new ChatTurn(state, {} as Bindings);
  runtime.migrate.mockRejectedValueOnce(new Error('temporary database failure'));
  await expect(turn.start('retry-turn')).rejects.toThrow('temporary database failure');
  expect(runtime.sessions.mock.calls.length).toBe(before);
  await turn.start('retry-turn');
  expect(runtime.sessions.mock.calls.length).toBe(before + 1);
});
