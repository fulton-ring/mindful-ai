import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const noticeName =
  /^(licen[cs]es?|notice|copying|copyright|authors|third[-_ ]?party[-_ ]?(?:notices?|licen[cs]es?))(?:$|[._-])/i;
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

function supplementSource(file) {
  return [
    file.canonicalTerms &&
      'Canonical license terms (reference text; not a package-authored license file).',
    `Source: ${file.source}`,
    file.sourceArchiveMember && `Source archive member: ${file.sourceArchiveMember}`,
    file.sourceEncoding === 'base64' &&
      'Source encoding: base64 (decoded before SHA-256 verification)',
    `SHA-256: ${file.sha256}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function supplementNotice(identity, supplement, supplementDirectory) {
  const lines = [];
  const commit = supplement.provenance?.resolvedCommit ?? supplement.provenance?.gitHead ?? '';
  const integrity =
    supplement.provenance?.npmIntegrity ?? supplement.provenance?.distIntegrity ?? '';
  const pinnedSource =
    /^[a-f0-9]{40}$/i.test(commit) ||
    /^(?:sha512-[A-Za-z0-9+/]{86}==|sha256-[A-Za-z0-9+/]{43}=)$/.test(integrity);
  if (
    !/^https:\/\//.test(supplement.provenance?.registry ?? '') ||
    !pinnedSource ||
    !Array.isArray(supplement.files) ||
    supplement.files.length === 0
  ) {
    throw new Error(`Invalid license supplement provenance: ${identity}`);
  }
  if (supplement.notice) lines.push(`Supplement context: ${supplement.notice}`);
  for (const file of supplement.files) {
    if (
      typeof file.path !== 'string' ||
      isAbsolute(file.path) ||
      file.path.split(/[\\/]/).includes('..') ||
      !/^https:\/\//.test(file.source ?? '') ||
      !/^[a-f0-9]{64}$/i.test(file.sha256 ?? '')
    ) {
      throw new Error(`Invalid license supplement file: ${identity}`);
    }
    const text = await readFile(join(supplementDirectory, file.path));
    if (
      !text.toString('utf8').trim() ||
      createHash('sha256').update(text).digest('hex') !== file.sha256.toLowerCase()
    ) {
      throw new Error(`License supplement checksum mismatch: ${identity} (${file.path})`);
    }
    lines.push(
      `\n--- Upstream supplement: ${file.path} ---\n${supplementSource(file)}\n${text.toString('utf8')}`,
    );
  }
  return lines.join('\n');
}

async function packageNotice(path, metadataLicense, supplements, supplementDirectory) {
  const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const files = await noticeFiles(path);
  const identity = `${pkg.name}@${pkg.version}`;
  const lines = [`Package: ${identity}`, `Declared license: ${metadataLicense}`];
  if (pkg.homepage) lines.push(`Upstream: ${pkg.homepage}`);
  if (!files.some((file) => /^(licen[cs]e|copying)/i.test(file.split('/').at(-1)))) {
    const supplement = supplements[identity];
    if (supplement) {
      lines.push(await supplementNotice(identity, supplement, supplementDirectory));
    } else {
      lines.push(`MISSING_LICENSE_TEXT: ${identity}`);
    }
    const entries = await readdir(path);
    files.push(...entries.filter((name) => /^readme(?:$|\.)/i.test(name)).sort());
  }
  for (const file of files) {
    lines.push(`\n--- ${file} ---\n${(await readFile(join(path, file), 'utf8')).trim()}`);
  }
  return lines.join('\n');
}

export async function generateNotices(
  inventory,
  { supplementDirectory = join(repository, 'licenses/npm') } = {},
) {
  const supplements = JSON.parse(
    await readFile(join(supplementDirectory, 'manifest.json'), 'utf8'),
  );
  const blocks = new Set();
  for (const [license, packages] of Object.entries(inventory)) {
    for (const pkg of packages) {
      for (const path of pkg.paths)
        blocks.add(await packageNotice(path, license, supplements, supplementDirectory));
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

export function parseNoticeArguments(args) {
  const filters = [];
  const outputs = [];
  for (const arg of args) {
    if (arg.startsWith('--filter=')) filters.push(arg.slice('--filter='.length));
    else if (arg.startsWith('--'))
      throw new Error('Usage: third-party-notices.mjs [--filter=WORKSPACE] OUTPUT [OUTPUT...]');
    else outputs.push(arg);
  }
  if (!outputs.length || filters.some((filter) => !filter.trim())) {
    throw new Error('Usage: third-party-notices.mjs [--filter=WORKSPACE] OUTPUT [OUTPUT...]');
  }
  return { filters, outputs };
}

async function main() {
  const { filters, outputs } = parseNoticeArguments(process.argv.slice(2));
  const inventory = JSON.parse(
    execFileSync(
      'pnpm',
      [
        ...filters.flatMap((filter) => ['--filter', filter]),
        'licenses',
        'list',
        '--prod',
        '--json',
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  );
  const content = [
    'WALDEN LICENSE AND ATTRIBUTION',
    await readFile(join(repository, 'LICENSE'), 'utf8'),
    await readFile(join(repository, 'NOTICE'), 'utf8'),
    await generateNotices(inventory),
  ].join('\n');
  for (const output of outputs) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  console.log(`Wrote third-party notices to ${outputs.length} artifact(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
