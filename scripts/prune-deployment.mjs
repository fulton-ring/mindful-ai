import { access, lstat, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const developmentFile = /(?:\.d\.[cm]?ts|\.[cm]?js\.map|\.d\.[cm]?ts\.map)$/;

async function size(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await size(join(path, entry));
  return total;
}

async function remove(path) {
  const bytes = await size(path);
  await rm(path, { recursive: true });
  return bytes;
}

async function onnxRemovals(store, platform, arch) {
  const packages = (await readdir(store)).filter((name) => name.startsWith('onnxruntime-node@'));
  if (!packages.length) throw new Error('Missing ONNX Runtime deployment');
  const removals = [];
  for (const name of packages) {
    const bin = join(store, name, 'node_modules/onnxruntime-node/bin/napi-v6');
    try {
      await access(join(bin, platform, arch, 'onnxruntime_binding.node'));
    } catch {
      throw new Error(`Missing ONNX Runtime binding for ${platform}/${arch}: ${name}`);
    }
    for (const os of await readdir(bin)) {
      if (os !== platform) removals.push(join(bin, os));
      else
        for (const cpu of await readdir(join(bin, os)))
          if (cpu !== arch) removals.push(join(bin, os, cpu));
    }
  }
  return removals;
}

async function developmentFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await developmentFiles(path)));
    else if (entry.isFile() && developmentFile.test(entry.name)) files.push(path);
  }
  return files;
}

/** Removes files unused by the production runtime from a pnpm deployment, never following links. */
export async function pruneDeployment(
  nodeModules,
  { platform = process.platform, arch = process.arch } = {},
) {
  const store = join(nodeModules, '.pnpm');
  let bytes = 0;
  for (const path of await onnxRemovals(store, platform, arch)) bytes += await remove(path);
  for (const path of await developmentFiles(store)) bytes += await remove(path);
  return { bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [nodeModules] = process.argv.slice(2);
  if (!nodeModules) throw new Error('Usage: prune-deployment.mjs NODE_MODULES');
  const before = await size(resolve(nodeModules));
  const { bytes } = await pruneDeployment(resolve(nodeModules));
  console.log(`Pruned ${bytes} of ${before} deployed bytes (${process.platform}/${process.arch}).`);
}
