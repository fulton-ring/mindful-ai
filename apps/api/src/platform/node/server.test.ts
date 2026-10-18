import { afterEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ createNodeRuntime: vi.fn(), serve: vi.fn() }));
vi.mock('./runtime', () => ({ createNodeRuntime: runtime.createNodeRuntime }));
vi.mock('@hono/node-server', () => ({ serve: runtime.serve }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('waits for automatic startup migrations and initialization before opening an HTTP listener', async () => {
  vi.resetModules();
  vi.stubEnv('APP_ROLE', 'http');
  vi.stubEnv('DATABASE_URL', 'postgres://fixture:fixture@127.0.0.1:1/fixture');
  vi.stubEnv('VALKEY_URL', 'redis://127.0.0.1:1');
  vi.stubEnv('FILE_STORAGE', 's3');
  vi.stubEnv('S3_BUCKET', 'fixture');
  vi.spyOn(process, 'once').mockReturnValue(process);
  let release!: (value: object) => void;
  runtime.createNodeRuntime.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const loading = import('./server');
  try {
    await vi.waitFor(() => expect(runtime.createNodeRuntime).toHaveBeenCalledOnce());
    expect(runtime.serve).not.toHaveBeenCalled();
    expect(runtime.createNodeRuntime.mock.calls[0][1].migrate).not.toBe(false);
  } finally {
    release({ fetch: vi.fn(), close: vi.fn() });
    await loading;
  }
  expect(runtime.serve).toHaveBeenCalledOnce();
});
