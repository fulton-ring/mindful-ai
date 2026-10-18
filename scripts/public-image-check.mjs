import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = [
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_LICENSES.txt',
  'public/THIRD_PARTY_LICENSES.txt',
  'models/minilm/LICENSE',
  'models/minilm/README.md',
  'models/minilm/model-manifest.json',
  'notices/manifest.json',
  'notices/debian-packages.tsv',
  'notices/debian-sources.json',
];

async function enterpriseFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const enterpriseDirectory = entry.isDirectory() && entry.name === 'ee';
    const mastraChunk =
      name.includes('@mastra/core/') && /^ee-.+\.[cm]?js(?:\.map)?$/.test(entry.name);
    if (enterpriseDirectory || mastraChunk) {
      files.push(name);
    } else if (entry.isDirectory()) {
      files.push(...(await enterpriseFiles(join(directory, entry.name), name)));
    }
  }
  return files;
}

async function packageDirectories(modules) {
  const paths = [];
  for (const pkg of await readdir(modules, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const path = join(modules, pkg.name);
    if (!pkg.name.startsWith('@')) paths.push(path);
    else {
      for (const scoped of await readdir(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) paths.push(join(path, scoped.name));
      }
    }
  }
  return paths;
}

async function runtimePackages(directory) {
  const packages = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    for (const path of await packageDirectories(join(directory, entry.name, 'node_modules'))) {
      const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      if (metadata.name && metadata.version) packages.add(`${metadata.name}@${metadata.version}`);
    }
  }
  return packages;
}

export async function inspectImageRoot(root) {
  const issues = [];
  const warnings = [];
  for (const file of required) {
    try {
      const artifact = await stat(join(root, file));
      if (!artifact.isFile() || !artifact.size)
        issues.push(`Invalid attribution artifact: ${file}`);
    } catch {
      issues.push(`Missing attribution artifact: ${file}`);
    }
  }
  for (const file of ['THIRD_PARTY_LICENSES.txt', 'public/THIRD_PARTY_LICENSES.txt']) {
    const content = await readFile(join(root, file), 'utf8').catch(() => '');
    const missing = content.match(/^MISSING_LICENSE_TEXT: .+$/gm) ?? [];
    issues.push(...missing.map((item) => `${file}: ${item}`));
  }
  try {
    const notices = await readFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'utf8');
    const retained = new Set([...notices.matchAll(/^Package: (.+)$/gm)].map((match) => match[1]));
    for (const identity of await runtimePackages(join(root, 'node_modules/.pnpm'))) {
      if (!retained.has(identity)) issues.push(`Runtime package absent from notices: ${identity}`);
    }
  } catch (error) {
    issues.push(`Cannot verify runtime attribution coverage: ${error.code ?? error.message}`);
  }
  try {
    for (const file of await enterpriseFiles(join(root, 'node_modules'))) {
      // Mastra's maintainer addressed bundled, unused EE files in upstream #22113.
      if (/(^|\/)@mastra\/core\//.test(file)) {
        warnings.push(`Bundled Mastra enterprise file (informational): ${file}`);
      } else {
        issues.push(`Enterprise payload requires upstream redistribution clearance: ${file}`);
      }
    }
  } catch (error) {
    issues.push(`Cannot inspect production dependencies: ${error.code}`);
  }
  return { issues, warnings };
}

async function main() {
  const [argument, root] = process.argv.slice(2);
  if (argument === '--root' && root) {
    const { issues, warnings } = await inspectImageRoot(root);
    if (warnings.length) {
      console.warn(warnings.join('\n'));
      console.warn('File presence does not identify enabled features; see THIRD_PARTY_NOTICES.md.');
    }
    if (issues.length) {
      console.error(issues.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        'Package-content checks passed. Release publication also requires verified matching native/OS source companions.',
      );
    }
    return;
  }
  if (!argument || argument.startsWith('-'))
    throw new Error('Usage: pnpm check:public-image IMAGE');
  const script = fileURLToPath(import.meta.url);
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'node',
      '--mount',
      `type=bind,src=${script},dst=/tmp/public-image-check.mjs,readonly`,
      argument,
      '/tmp/public-image-check.mjs',
      '--root',
      '/app',
    ],
    { stdio: 'inherit' },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
