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
}));

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
