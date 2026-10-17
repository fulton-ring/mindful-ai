import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const test = process.env.WALDEN_TEST_WORKER_BUNDLE === '1' ? it : it.skip;

/** Opt in after `pnpm --filter @walden/api build`; this consumes its exact emitted modules. */
test('boots the emitted Wrangler worker and initializes the actual ChatTurn SQLite DO', async () => {
  const bundle = join(dirname(fileURLToPath(import.meta.url)), '../../dist/worker.js');
  await access(bundle);
  const wasmFiles = (await readdir(dirname(bundle))).filter((name) => name.endsWith('.wasm'));
  const wasmModules = await Promise.all(
    wasmFiles.map(async (name) => ({
      type: 'CompiledWasm',
      path: join(dirname(bundle), name),
      contents: await readFile(join(dirname(bundle), name)),
    })),
  );
  const options = convertV4MiniflareOptions({
    name: 'production-worker-gate',
    modules: [
      { type: 'ESModule', path: bundle, contents: await readFile(bundle, 'utf8') },
      ...wasmModules,
    ],
    modulesRoot: dirname(bundle),
    compatibilityDate: '2026-09-18',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { AUTH_MODE: 'none' },
    d1Databases: { DB: 'production-worker-fixture' },
    durableObjects: { CHAT_TURN: { className: 'ChatTurn', useSQLite: true } },
  });
  const mf = new Miniflare(options);
  try {
    const config = await mf.dispatchFetch('http://local/api/config');
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ auth: { mode: 'none' }, turnProtocolVersion: 2 });
    const database = await mf.getD1Database('DB');
    await database.exec('CREATE TABLE turns(id TEXT PRIMARY KEY)');
    const namespace = await mf.getDurableObjectNamespace('CHAT_TURN');
    const stub = namespace.get(namespace.idFromName('nonexistent'));
    await stub.start('nonexistent');
    const stream = await stub.stream('nonexistent', 0);
    expect(stream.status).toBe(204);
    await stub.purge('nonexistent');
    await stub.purge('nonexistent');
    expect((await stub.stream('nonexistent', 0)).status).toBe(204);
  } finally {
    await mf.dispose();
  }
}, 30000);
