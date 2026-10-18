import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { get } from 'node:https';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repository = fileURLToPath(new URL('../', import.meta.url));
const nativeDirectory =
  process.env.WALDEN_NATIVE_LICENSES_DIR || join(repository, 'licenses/native');
const noticeName =
  /^(?:licen[cs]e|notice|copying|copyright|authors|about|third.party.notices)(?:$|[._-])/i;
const dpkgFormat = '${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n';
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
const sha256 = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

function artifactPath(root, path) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
    throw new Error(`Unsafe artifact path: ${path}`);
  return join(root, path);
}

export async function verifyFiles(root, files) {
  if (!files.length) throw new Error('No artifacts to verify');
  for (const file of files) {
    const path = artifactPath(root, file.path);
    const actual = await sha256(path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || actual !== file.sha256)
      throw new Error(`Artifact checksum mismatch: ${file.path}`);
  }
}

export function parseDpkgInventory(content) {
  const sources = new Map();
  for (const line of content.trim().split('\n')) {
    const columns = line.split('\t');
    if (
      columns.length !== 4 ||
      columns.some((value) => !value) ||
      !/^[a-z0-9][a-z0-9+.-]*$/.test(columns[2]) ||
      !/^[a-zA-Z0-9.+:~_-]+$/.test(columns[3])
    )
      throw new Error(`Invalid dpkg inventory: ${line}`);
    sources.set(`${columns[2]}=${columns[3]}`, { package: columns[2], version: columns[3] });
  }
  return [...sources.values()].sort((a, b) => a.package.localeCompare(b.package));
}

// Follow Debian documentation symlinks, while rejecting cycles and links outside the input tree.
export async function collectNoticeFiles(root, output, directory = root, ancestors = []) {
  const canonical = await realpath(directory);
  if (relative(await realpath(root), canonical).startsWith('..') || ancestors.includes(canonical))
    throw new Error(`Unsafe documentation symlink: ${directory}`);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    let info = entry;
    if (entry.isSymbolicLink()) {
      try {
        info = await stat(path);
      } catch (error) {
        if (error.code === 'ENOENT' && !noticeName.test(entry.name)) continue;
        throw error;
      }
    }
    if (info.isDirectory()) {
      files.push(...(await collectNoticeFiles(root, output, path, [...ancestors, canonical])));
      continue;
    }
    if (!info.isFile() || !noticeName.test(entry.name)) continue;
    if (relative(await realpath(root), await realpath(path)).startsWith('..'))
      throw new Error(`Unsafe documentation symlink: ${path}`);
    const name = relative(root, path);
    await mkdir(dirname(join(output, name)), { recursive: true });
    await copyFile(path, join(output, name));
    files.push({ path: name, sha256: await sha256(join(output, name)) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

export async function verifyNativeVersions(nodeModules, pins, nodeVersion = process.versions.node) {
  if (nodeVersion !== pins.node)
    throw new Error(`Node notice version mismatch: ${nodeVersion} != ${pins.node}`);
  const store = join(nodeModules, '.pnpm');
  const entries = await readdir(store);
  const aliases = { canvas: '@napi-rs/canvas' };
  const prefixes = { 'sharp-libvips': '@img+sharp-libvips-linux' };
  for (const [name, pin] of Object.entries(pins).filter(([name]) => name !== 'node')) {
    const packageName = aliases[name] || name;
    const prefix = prefixes[name] || `${packageName.replace('/', '+')}@`;
    const matched = entries.filter((entry) => entry.startsWith(prefix));
    if (!matched.length) throw new Error(`Missing native package: ${name}`);
    for (const entry of matched) {
      const installedName =
        name === 'sharp-libvips'
          ? entry.slice(0, entry.lastIndexOf('@')).replace('+', '/')
          : packageName;
      const directory = join(store, entry, 'node_modules', installedName);
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const libraries = pin.libraries
        ? JSON.parse(await readFile(join(directory, 'versions.json'), 'utf8'))
        : undefined;
      if (
        metadata.version !== pin.version ||
        (pin.libraries && !isDeepStrictEqual(libraries, pin.libraries))
      )
        throw new Error(`Native source pins do not match deployed package: ${entry}`);
    }
  }
}

async function collectRuntime(output) {
  await mkdir(output, { recursive: true });
  const sourcePins = JSON.parse(await readFile(join(nativeDirectory, 'sources.json'), 'utf8'));
  await verifyNativeVersions(
    process.env.WALDEN_NODE_MODULES_DIR || '/app/node_modules',
    sourcePins.components,
  );
  const inventory = run('dpkg-query', ['-W', `-f=${dpkgFormat}`]);
  await writeFile(join(output, 'debian-packages.tsv'), inventory);
  await writeJson(join(output, 'debian-sources.json'), parseDpkgInventory(inventory));
  const files = [];
  for (const line of inventory.trim().split('\n'))
    await readFile(`/usr/share/doc/${line.split('\t')[0].split(':')[0]}/copyright`);
  for (const [input, target] of [
    ['/usr/share/doc', 'debian'],
    ['/usr/share/common-licenses', 'common-licenses'],
  ]) {
    const copied = await collectNoticeFiles(input, join(output, target));
    files.push(...copied.map((file) => ({ ...file, path: `${target}/${file.path}` })));
  }
  const upstream = nativeDirectory;
  await mkdir(join(output, 'upstream'), { recursive: true });
  for (const entry of await readdir(upstream)) {
    if (!(await stat(join(upstream, entry))).isFile()) continue;
    const path = `upstream/${entry}`;
    await copyFile(join(upstream, entry), join(output, path));
    files.push({ path, sha256: await sha256(join(output, path)) });
  }
  // common-licenses filenames are SPDX identifiers, rather than LICENSE/COPYING.
  await mkdir(join(output, 'common-licenses'), { recursive: true });
  for (const entry of await readdir('/usr/share/common-licenses')) {
    const path = `common-licenses/${entry}`;
    await copyFile(`/usr/share/common-licenses/${entry}`, join(output, path));
    if (!files.some((file) => file.path === path))
      files.push({ path, sha256: await sha256(join(output, path)) });
  }
  const chrome = process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';
  const credits = run(
    chrome,
    [
      '--no-sandbox',
      '--headless',
      '--allow-chrome-scheme-url',
      '--disable-gpu',
      '--dump-dom',
      'chrome://credits',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (
    !credits.includes('<title>Credits</title>') ||
    !credits.includes('GNU LESSER GENERAL PUBLIC LICENSE') ||
    credits.length < 100_000
  )
    throw new Error('Chromium did not return its embedded third-party credits');
  await mkdir(join(output, 'browser'), { recursive: true });
  await writeFile(join(output, 'browser', 'chromium-credits.html'), credits);
  files.push({
    path: 'browser/chromium-credits.html',
    sha256: await sha256(join(output, 'browser/chromium-credits.html')),
  });
  await writeFile(join(output, 'browser', 'chromium-version.txt'), run(chrome, ['--version']));
  for (const path of ['debian-packages.tsv', 'debian-sources.json', 'browser/chromium-version.txt'])
    files.push({ path, sha256: await sha256(join(output, path)) });
  await writeJson(join(output, 'manifest.json'), { files });
  await verifyFiles(output, files);
}

const httpsBody = (url, redirects = 5) =>
  new Promise((resolve, reject) => {
    get(url, (response) => {
      const { statusCode, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
        response.resume();
        resolve(httpsBody(new URL(headers.location, url).href, redirects - 1));
      } else if (statusCode === 200) resolve(response);
      else {
        response.resume();
        reject(new Error(`Download failed (${statusCode}): ${url}`));
      }
    }).on('error', reject);
  });

async function fetchSources(output) {
  const manifest = JSON.parse(await readFile(join(nativeDirectory, 'sources.json'), 'utf8'));
  await mkdir(output, { recursive: true });
  const download = async (file) => {
    const path = artifactPath(output, file.path);
    await mkdir(dirname(path), { recursive: true });
    let alreadyValid = false;
    try {
      alreadyValid = (await sha256(path)) === file.sha256;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (alreadyValid) return;
    await pipeline(await httpsBody(file.source), createWriteStream(path));
    await verifyFiles(output, [file]);
  };
  for (let i = 0; i < manifest.files.length; i += 6)
    await Promise.all(manifest.files.slice(i, i + 6).map(download));
  await writeJson(join(output, 'manifest.json'), manifest);
  await verifyFiles(output, manifest.files);
}

async function debianSources(inventoryPath, output) {
  const sources = parseDpkgInventory(await readFile(inventoryPath, 'utf8'));
  await mkdir(output, { recursive: true });
  for (const source of sources) {
    // apt authenticates source indices and checks archive hashes; no --allow-unauthenticated.
    run(
      'apt-get',
      ['source', '--download-only', '--only-source', `${source.package}=${source.version}`],
      { cwd: output, stdio: 'inherit' },
    );
  }
  const files = [];
  for (const name of (await readdir(output)).sort()) {
    if (name === 'manifest.json' || !(await stat(join(output, name))).isFile()) continue;
    files.push({ path: name, sha256: await sha256(join(output, name)) });
  }
  for (const source of sources) {
    const descriptors = files.filter((file) => file.path.endsWith('.dsc'));
    let found = false;
    for (const descriptor of descriptors) {
      const text = await readFile(join(output, descriptor.path), 'utf8');
      if (
        !text.includes(`Source: ${source.package}\n`) ||
        !text.includes(`Version: ${source.version}\n`)
      )
        continue;
      found = true;
      const checksums = text.match(/\nChecksums-Sha256:\n((?: [^\n]+\n)+)/)?.[1];
      if (!checksums) throw new Error(`Missing source hashes: ${descriptor.path}`);
      const referenced = checksums
        .trim()
        .split('\n')
        .map((line) => {
          const [hash, , path] = line.trim().split(/\s+/);
          return { path, sha256: hash };
        });
      await verifyFiles(output, referenced);
    }
    if (!found)
      throw new Error(`Missing Debian source descriptor: ${source.package}=${source.version}`);
  }
  await writeJson(join(output, 'manifest.json'), { sources, files });
}

export async function splitArchive(input, output, maxBytes = 1_500_000_000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error('Part size must be a positive integer');
  await mkdir(output, { recursive: true });
  const files = [];
  const wholeHash = createHash('sha256');
  let handle,
    partHash,
    partBytes = 0,
    total = 0;
  const finishPart = async () => {
    await handle.close();
    files.push({
      path: `${basename(input)}.part-${String(files.length).padStart(4, '0')}`,
      bytes: partBytes,
      sha256: partHash.digest('hex'),
    });
    handle = undefined;
  };
  try {
    for await (const chunk of createReadStream(input)) {
      wholeHash.update(chunk);
      total += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        if (!handle) {
          handle = await open(
            join(output, `${basename(input)}.part-${String(files.length).padStart(4, '0')}`),
            'w',
          );
          partHash = createHash('sha256');
          partBytes = 0;
        }
        const end = Math.min(chunk.length, offset + maxBytes - partBytes);
        const slice = chunk.subarray(offset, end);
        await handle.writeFile(slice);
        partHash.update(slice);
        partBytes += slice.length;
        offset = end;
        if (partBytes === maxBytes) await finishPart();
      }
    }
    if (handle) await finishPart();
  } finally {
    if (handle) await handle.close();
  }
  if (!files.length) throw new Error('Cannot split an empty archive');
  const manifest = {
    archive: { path: basename(input), bytes: total, sha256: wholeHash.digest('hex') },
    files,
  };
  await writeJson(join(output, 'manifest.json'), manifest);
  return manifest;
}

async function main() {
  const [command, path, output] = process.argv.slice(2);
  if (command === 'runtime' && path) await collectRuntime(resolve(path));
  else if (command === 'sources' && path) await fetchSources(resolve(path));
  else if (command === 'debian-sources' && path && output)
    await debianSources(resolve(path), resolve(output));
  else if (command === 'split' && path && output)
    await splitArchive(resolve(path), resolve(output));
  else if (command === 'verify' && path)
    await verifyFiles(
      resolve(path),
      JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')).files,
    );
  else
    throw new Error(
      'Usage: container-notices.mjs runtime OUTPUT | sources OUTPUT | debian-sources INVENTORY.tsv OUTPUT | split ARCHIVE OUTPUT | verify DIRECTORY',
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
