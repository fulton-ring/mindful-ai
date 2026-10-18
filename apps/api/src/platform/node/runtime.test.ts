import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readNodeConfig } from './config';
import { createNodeRuntime } from './runtime';

it.skipIf(!process.env.EMBEDDING_MODEL_DIR)(
  'boots the shared API with one stable default account across restarts and serves same-origin assets',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'walden-runtime-'));
    const publicDir = join(directory, 'public');
    await mkdir(publicDir);
    await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Walden</title>');
    const config = readNodeConfig({
      APP_ROOT: resolve('.'),
      DATA_DIR: directory,
      PUBLIC_DIR: publicDir,
      EMBEDDING_MODEL_DIR: process.env.EMBEDDING_MODEL_DIR ?? '/tmp/walden-minilm',
    });
    let runtime = await createNodeRuntime(config, { environment: {} });
    const request = (path: string) => runtime.fetch(new Request(`http://localhost:3000${path}`));
    try {
      expect((await request('/health/ready')).status).toBe(200);
      expect(await (await request('/notes/path')).text()).toContain('<title>Walden</title>');
      expect((await request('/missing.js')).status).toBe(404);
      const account = (await (await request('/api/account')).json()) as {
        id: string;
        authMode: string;
      };
      expect(account).toMatchObject({ authMode: 'none', id: expect.any(String) });
      expect(await (await request('/api/config')).json()).toMatchObject({
        auth: { mode: 'none' },
        inference: { configured: false },
        capabilities: { documentExtraction: true, savedSourceSearch: true },
      });
      await runtime.close();
      runtime = await createNodeRuntime(config, { environment: {} });
      expect(await (await request('/api/account')).json()).toEqual(account);
      await runtime.db
        .prepare("UPDATE app_settings SET value='clerk' WHERE key='accepted_auth_mode'")
        .run();
      await runtime.close();
      await expect(createNodeRuntime(config, { environment: {} })).rejects.toThrow(
        'Authentication mode changed',
      );
    } finally {
      await runtime.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);
