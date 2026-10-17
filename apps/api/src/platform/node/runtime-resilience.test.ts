import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readNodeConfig } from './config';
import { createNodeRuntime } from './runtime';

const test = process.env.EMBEDDING_MODEL_DIR ? it : it.skip;
async function fixture(extra: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'walden-resilience-'));
  const config = readNodeConfig({
    APP_ROOT: resolve('.'),
    DATA_DIR: directory,
    EMBEDDING_MODEL_DIR: process.env.EMBEDDING_MODEL_DIR,
    ...extra,
  });
  const runtime = await createNodeRuntime(config, { environment: {} });
  return {
    runtime,
    cleanup: async () => {
      await runtime.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('closes the application database even when another resource fails to close', async () => {
  const { runtime, cleanup } = await fixture();
  const storage = runtime.env.EXECUTION!.storage;
  const original = storage.close.bind(storage);
  storage.close = async () => {
    await original();
    throw new Error('Injected close failure');
  };
  try {
    await expect(runtime.close()).rejects.toThrow('Runtime shutdown failed');
    expect(() => runtime.db.prepare('SELECT 1')).toThrow();
    await expect(runtime.close()).rejects.toThrow('Runtime shutdown failed');
  } finally {
    await cleanup();
  }
});

test('fails readiness when the configured S3 service becomes unavailable', async () => {
  let healthy = true;
  const server = createServer((_req, res) => {
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/xml' });
    res.end(
      healthy
        ? '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>walden</Name><IsTruncated>false</IsTruncated></ListBucketResult>'
        : '<Error><Code>ServiceUnavailable</Code></Error>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const { runtime, cleanup } = await fixture({
    FILE_STORAGE: 's3',
    S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
    S3_BUCKET: 'walden',
    S3_ACCESS_KEY_ID: 'fixture',
    S3_SECRET_ACCESS_KEY: 'fixture',
  });
  const request = () => runtime.fetch(new Request('http://localhost:3000/health/ready'));
  try {
    expect((await request()).status).toBe(200);
    healthy = false;
    expect((await request()).status).toBe(503);
  } finally {
    await cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
