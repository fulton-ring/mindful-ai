import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pruneDeployment } from './prune-deployment.mjs';

const onnx = 'onnxruntime-node@1.30.0/node_modules/onnxruntime-node/bin/napi-v6';
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

async function deployment(t) {
  const root = await mkdtemp(join(tmpdir(), 'walden-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'node_modules/.pnpm');
  const files = [
    'pkg@1.0.0/node_modules/pkg/package.json',
    'pkg@1.0.0/node_modules/pkg/LICENSE',
    'pkg@1.0.0/node_modules/pkg/index.js',
    'pkg@1.0.0/node_modules/pkg/index.mjs',
    'pkg@1.0.0/node_modules/pkg/index.js.map',
    'pkg@1.0.0/node_modules/pkg/index.mjs.map',
    'pkg@1.0.0/node_modules/pkg/index.d.ts',
    'pkg@1.0.0/node_modules/pkg/index.d.mts',
    'pkg@1.0.0/node_modules/pkg/index.d.cts',
    'pkg@1.0.0/node_modules/pkg/index.d.ts.map',
    'pkg@1.0.0/node_modules/pkg/data/schema.json',
    'pkg@1.0.0/node_modules/pkg/data/style.css.map',
    'pkg@1.0.0/node_modules/pkg/src/runtime.ts',
    `${onnx}/linux/x64/onnxruntime_binding.node`,
    `${onnx}/linux/x64/libonnxruntime.so.1`,
    `${onnx}/linux/arm64/onnxruntime_binding.node`,
    `${onnx}/linux/arm64/libonnxruntime.so.1`,
    `${onnx}/darwin/arm64/onnxruntime_binding.node`,
    `${onnx}/win32/x64/onnxruntime_binding.node`,
    'onnxruntime-node@1.30.0/node_modules/onnxruntime-node/package.json',
  ];
  for (const file of files) {
    await mkdir(dirname(join(store, file)), { recursive: true });
    await writeFile(join(store, file), file);
  }
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'kept.d.ts'), 'outside');
  await symlink(outside, join(store, 'pkg@1.0.0/node_modules/linked'));
  await symlink(join(outside, 'kept.d.ts'), join(store, 'pkg@1.0.0/node_modules/pkg/linked.d.ts'));
  return { root, store };
}

for (const arch of ['x64', 'arm64']) {
  test(`deployment pruning keeps runtime files and only the linux ${arch} ONNX binding`, async (t) => {
    const { root, store } = await deployment(t);
    const pkg = join(store, 'pkg@1.0.0/node_modules/pkg');
    const result = await pruneDeployment(join(root, 'node_modules'), { platform: 'linux', arch });
    for (const kept of [
      'package.json',
      'LICENSE',
      'index.js',
      'index.mjs',
      'data/schema.json',
      'data/style.css.map',
      'src/runtime.ts',
    ])
      assert.ok(await exists(join(pkg, kept)), kept);
    for (const removed of [
      'index.js.map',
      'index.mjs.map',
      'index.d.ts',
      'index.d.mts',
      'index.d.cts',
      'index.d.ts.map',
    ])
      assert.equal(await exists(join(pkg, removed)), false, removed);
    const other = arch === 'x64' ? 'arm64' : 'x64';
    assert.ok(await exists(join(store, onnx, 'linux', arch, 'onnxruntime_binding.node')));
    assert.ok(await exists(join(store, onnx, 'linux', arch, 'libonnxruntime.so.1')));
    for (const removed of [`linux/${other}`, 'darwin', 'win32'])
      assert.equal(await exists(join(store, onnx, removed)), false, removed);
    assert.ok(await exists(join(root, 'outside/kept.d.ts')));
    assert.ok(await readlink(join(pkg, 'linked.d.ts')));
    assert.ok(result.bytes > 0);
  });
}

test('deployment pruning fails closed without the target ONNX binding', async (t) => {
  const { root, store } = await deployment(t);
  await rm(join(store, onnx, 'linux/arm64/onnxruntime_binding.node'));
  await assert.rejects(
    pruneDeployment(join(root, 'node_modules'), { platform: 'linux', arch: 'arm64' }),
    /Missing ONNX Runtime binding for linux\/arm64/,
  );
  assert.ok(await exists(join(store, onnx, 'linux/x64/onnxruntime_binding.node')));
  assert.ok(await exists(join(store, 'pkg@1.0.0/node_modules/pkg/index.d.ts')));
});

test('deployment pruning fails closed when ONNX Runtime is not deployed', async (t) => {
  const { root, store } = await deployment(t);
  await rm(join(store, 'onnxruntime-node@1.30.0'), { recursive: true });
  await assert.rejects(
    pruneDeployment(join(root, 'node_modules'), { platform: 'linux', arch: 'x64' }),
    /Missing ONNX Runtime deployment/,
  );
});
