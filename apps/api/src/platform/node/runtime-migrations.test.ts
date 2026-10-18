import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { NODE_ROLES, readNodeConfig } from './config';
import { createNodeRuntime } from './runtime';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function config() {
  const root = await mkdtemp(join(tmpdir(), 'walden-startup-migrations-'));
  directories.push(root);
  await cp(resolve('migrations'), join(root, 'migrations'), { recursive: true });
  return readNodeConfig({ APP_ROOT: root, DATA_DIR: join(root, 'data') });
}

it.each(NODE_ROLES)(
  'automatically migrates a fresh database before returning the %s runtime',
  async (role) => {
    const runtime = await createNodeRuntime(
      { ...(await config()), role },
      { maintenance: true, environment: {} },
    );
    try {
      await runtime.ready();
      expect(
        await runtime.db.prepare('SELECT count(*) AS total FROM app_migrations').first('total'),
      ).toBeGreaterThan(0);
      expect((await runtime.fetch(new Request('http://localhost/health/ready'))).status).toBe(200);
    } finally {
      await runtime.close();
    }
  },
);

it('retains explicit schema-only startup for advanced callers without silently upgrading', async () => {
  const settings = await config();
  await expect(
    createNodeRuntime(settings, { maintenance: true, migrate: false, environment: {} }),
  ).rejects.toThrow(/schema/);
  const migrated = await createNodeRuntime(settings, { maintenance: true, environment: {} });
  await migrated.close();
  const checked = await createNodeRuntime(settings, {
    maintenance: true,
    migrate: false,
    environment: {},
  });
  try {
    await checked.ready();
  } finally {
    await checked.close();
  }
});
