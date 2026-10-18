import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectNoticeFiles, parseDpkgInventory, verifyFiles } from './container-notices.mjs';

test('collects native copyright files through Debian documentation symlinks and ignores binaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  await mkdir(join(root, 'doc', 'libfoo'), { recursive: true });
  await writeFile(join(root, 'doc', 'libfoo', 'copyright'), 'Copyright example\nMIT License\n');
  await symlink('libfoo', join(root, 'doc', 'libfoo2'));
  await writeFile(join(root, 'doc', 'libfoo', 'binary.so'), 'binary');
  const files = await collectNoticeFiles(join(root, 'doc'), join(root, 'out'));
  assert.deepEqual(
    files.map((file) => file.path),
    ['libfoo/copyright', 'libfoo2/copyright'],
  );
  assert.equal(
    await readFile(join(root, 'out', files[0].path), 'utf8'),
    'Copyright example\nMIT License\n',
  );
  await verifyFiles(join(root, 'out'), files);
  await writeFile(join(root, 'out', files[0].path), 'changed');
  await assert.rejects(verifyFiles(join(root, 'out'), files), /checksum mismatch/);
});

test('inventory records exact Debian source versions, deduplicating binary packages', () => {
  assert.deepEqual(parseDpkgInventory('libfoo:arm64\t2+b1\tfoo\t2\nfoo-bin\t2\tfoo\t2\n'), [
    { package: 'foo', version: '2' },
  ]);
  assert.throws(() => parseDpkgInventory('bad\tentry'), /Invalid dpkg inventory/);
});

test('offline verification rejects a missing artifact and path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  await assert.rejects(
    verifyFiles(root, [{ path: '../outside', sha256: '0'.repeat(64) }]),
    /Unsafe artifact path/,
  );
  await assert.rejects(verifyFiles(root, [{ path: 'missing', sha256: '0'.repeat(64) }]), /ENOENT/);
});

test('splits source archives with independently verifiable parts and a complete archive hash', async () => {
  const { splitArchive } = await import('./container-notices.mjs');
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  const input = join(root, 'sources.tar');
  await writeFile(input, '12345678');
  const result = await splitArchive(input, join(root, 'parts'), 3);
  assert.deepEqual(
    result.files.map((file) => file.bytes),
    [3, 3, 2],
  );
  const chunks = await Promise.all(
    result.files.map((file) => readFile(join(root, 'parts', file.path))),
  );
  assert.equal(Buffer.concat(chunks).toString(), '12345678');
  assert.equal(result.archive.bytes, 8);
  await verifyFiles(join(root, 'parts'), result.files);
  await assert.rejects(splitArchive(input, join(root, 'bad'), 0), /positive integer/);
});

test('ignores dangling non-notice links in slim Debian docs but fails on missing copyright text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  await mkdir(join(root, 'doc'));
  await symlink('removed-by-slim', join(root, 'doc', 'NEWS.gz'));
  await writeFile(join(root, 'doc', 'copyright'), 'MIT License\n');
  assert.equal((await collectNoticeFiles(join(root, 'doc'), join(root, 'out'))).length, 1);
  await symlink('missing', join(root, 'doc', 'COPYING'));
  await assert.rejects(collectNoticeFiles(join(root, 'doc'), join(root, 'out')), /ENOENT/);
});

test('native source pins reject changed deployed library versions', async () => {
  const { verifyNativeVersions } = await import('./container-notices.mjs');
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  const lib = join(
    root,
    '.pnpm',
    '@img+sharp-libvips-linux-arm64@1.3.3',
    'node_modules',
    '@img',
    'sharp-libvips-linux-arm64',
  );
  const canvas = join(
    root,
    '.pnpm',
    '@napi-rs+canvas@1.0.11',
    'node_modules',
    '@napi-rs',
    'canvas',
  );
  await mkdir(lib, { recursive: true });
  await mkdir(canvas, { recursive: true });
  await writeFile(join(lib, 'package.json'), JSON.stringify({ version: '1.3.3' }));
  await writeFile(join(lib, 'versions.json'), JSON.stringify({ vips: '8.18.6' }));
  await writeFile(join(canvas, 'package.json'), JSON.stringify({ version: '1.0.11' }));
  const pins = {
    node: '24.15.0',
    'sharp-libvips': { version: '1.3.3', libraries: { vips: '8.18.6' } },
    canvas: { version: '1.0.11' },
  };
  await verifyNativeVersions(root, pins, '24.15.0');
  await writeFile(join(lib, 'versions.json'), JSON.stringify({ vips: '8.19.0' }));
  await assert.rejects(
    verifyNativeVersions(root, pins, '24.15.0'),
    /Native source pins do not match/,
  );
});

test('rejects changed ONNX versions so Eigen source pins cannot silently drift', async () => {
  const { verifyNativeVersions } = await import('./container-notices.mjs');
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  for (const [entry, pkg, version, versions] of [
    [
      '@img+sharp-libvips-linux-x64@1.3.3',
      '@img/sharp-libvips-linux-x64',
      '1.3.3',
      { vips: '8.18.6' },
    ],
    ['@napi-rs+canvas@1.0.11', '@napi-rs/canvas', '1.0.11'],
    ['onnxruntime-node@1.30.1', 'onnxruntime-node', '1.30.1'],
  ]) {
    const directory = join(root, '.pnpm', entry, 'node_modules', pkg);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version }));
    if (versions) await writeFile(join(directory, 'versions.json'), JSON.stringify(versions));
  }
  const pins = {
    node: '24.15.0',
    'sharp-libvips': { version: '1.3.3', libraries: { vips: '8.18.6' } },
    canvas: { version: '1.0.11' },
    'onnxruntime-node': { version: '1.30.0' },
  };
  await assert.rejects(
    verifyNativeVersions(root, pins, '24.15.0'),
    /Native source pins do not match/,
  );
});

test('rejects notice file symlinks outside the documentation root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  await mkdir(join(root, 'doc'));
  await writeFile(join(root, 'outside'), 'outside');
  await symlink('../outside', join(root, 'doc', 'copyright'));
  await assert.rejects(
    collectNoticeFiles(join(root, 'doc'), join(root, 'out')),
    /Unsafe documentation symlink/,
  );
});
