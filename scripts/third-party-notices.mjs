import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const noticeName = /^(licen[cs]e|notice|copying|copyright|authors)(?:$|[._-])/i;
const sourceExtension = /\.(?:[cm]?js|[cm]?ts|map|json)$/i;

export async function noticeFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
      files.push(...(await noticeFiles(root, path)));
    } else if (entry.isFile() && noticeName.test(entry.name) && !sourceExtension.test(entry.name)) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

async function packageNotice(path, metadataLicense) {
  const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const files = await noticeFiles(path);
  const identity = `${pkg.name}@${pkg.version}`;
  const lines = [`Package: ${identity}`, `Declared license: ${metadataLicense}`];
  if (pkg.homepage) lines.push(`Upstream: ${pkg.homepage}`);
  if (!files.some((file) => /^(licen[cs]e|copying)/i.test(file.split('/').at(-1)))) {
    lines.push(`MISSING_LICENSE_TEXT: ${identity}`);
    const entries = await readdir(path);
    files.push(...entries.filter((name) => /^readme(?:$|\.)/i.test(name)).sort());
  }
  for (const file of files) {
    lines.push(`\n--- ${file} ---\n${(await readFile(join(path, file), 'utf8')).trim()}`);
  }
  return lines.join('\n');
}

export async function generateNotices(inventory) {
  const blocks = new Set();
  for (const [license, packages] of Object.entries(inventory)) {
    for (const pkg of packages) {
      for (const path of pkg.paths) blocks.add(await packageNotice(path, license));
    }
  }
  return [
    'THIRD-PARTY LICENSES AND NOTICES',
    'Generated from installed workspace production dependencies; includes a superset of bundled JavaScript dependencies.',
    'Upstream text is retained verbatim. Metadata is informational and does not grant redistribution rights.',
    'MISSING_LICENSE_TEXT entries require upstream review before public distribution.',
    'Browser, model, OS and native-library distribution obligations also apply; see THIRD_PARTY_NOTICES.md.',
    ...[...blocks].sort().map((block) => `\n${'='.repeat(80)}\n${block}`),
    '',
  ].join('\n');
}

async function main() {
  const outputs = process.argv.slice(2);
  if (!outputs.length)
    throw new Error('Usage: node scripts/third-party-notices.mjs OUTPUT [OUTPUT...]');
  const inventory = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const content = await generateNotices(inventory);
  for (const output of outputs) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  console.log(`Wrote third-party notices to ${outputs.length} artifact(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
