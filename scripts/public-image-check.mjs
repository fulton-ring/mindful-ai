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
];

async function enterpriseFiles(directory, prefix = '') {
  const issues = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const enterpriseDirectory = entry.isDirectory() && entry.name === 'ee';
    const mastraChunk =
      name.includes('@mastra/core/') && /^ee-.+\.[cm]?js(?:\.map)?$/.test(entry.name);
    if (enterpriseDirectory || mastraChunk) {
      issues.push(`Enterprise payload requires upstream redistribution clearance: ${name}`);
    } else if (entry.isDirectory()) {
      issues.push(...(await enterpriseFiles(join(directory, entry.name), name)));
    }
  }
  return issues;
}

export async function inspectImageRoot(root) {
  const issues = [];
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
    issues.push(...(await enterpriseFiles(join(root, 'node_modules'))));
  } catch (error) {
    issues.push(`Cannot inspect production dependencies: ${error.code}`);
  }
  return issues;
}

async function main() {
  const [argument, root] = process.argv.slice(2);
  if (argument === '--root' && root) {
    const issues = await inspectImageRoot(root);
    if (issues.length) {
      console.error(issues.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        'Package-content checks passed. Review native/browser/OS licensing before publication.',
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
