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

async function packageNotice(path, metadataLicense, supplements, supplementDirectory, workspace) {
  const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const files = await noticeFiles(path);
  const identity = `${pkg.name}@${pkg.version}`;
  const lines = [`Package: ${identity}`, `Declared license: ${metadataLicense}`];
  if (pkg.homepage) lines.push(`Upstream: ${pkg.homepage}`);
  const hasLicense = files.some((file) => /^(licen[cs]e|copying)/i.test(file.split('/').at(-1)));
  if (!hasLicense && workspace.has(identity)) {
    lines.push(
      `\n--- Walden repository LICENSE ---\n${(await readFile(join(repository, 'LICENSE'), 'utf8')).trim()}`,
    );
  } else if (!hasLicense) {
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
  { supplementDirectory = join(repository, 'licenses/npm'), workspacePackages = new Set() } = {},
) {
  const supplements = JSON.parse(
    await readFile(join(supplementDirectory, 'manifest.json'), 'utf8'),
  );
  const blocks = new Set();
  for (const [license, packages] of Object.entries(inventory)) {
    for (const pkg of packages) {
      for (const path of pkg.paths)
        blocks.add(
          await packageNotice(path, license, supplements, supplementDirectory, workspacePackages),
        );
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

async function packageDirectories(modules) {
  const paths = [];
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(modules, entry.name);
    if (!entry.name.startsWith('@')) paths.push(path);
    else {
      for (const scoped of await readdir(path, { withFileTypes: true }))
        if (scoped.isDirectory()) paths.push(join(path, scoped.name));
    }
  }
  return paths;
}

function declaredLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses))
    return pkg.licenses.map((license) => license.type ?? license).join(' OR ');
  return 'Unknown';
}

export async function addDeployedPackages(inventory, nodeModules) {
  const listed = new Set(
    Object.values(inventory)
      .flat()
      .flatMap((pkg) => pkg.versions.map((version) => `${pkg.name}@${version}`)),
  );
  const store = join(nodeModules, '.pnpm');
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    for (const path of await packageDirectories(join(store, entry.name, 'node_modules'))) {
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      if (!pkg.name || !pkg.version || listed.has(`${pkg.name}@${pkg.version}`)) continue;
      const license = declaredLicense(pkg);
      inventory[license] = [
        ...(inventory[license] ?? []),
        { name: pkg.name, versions: [pkg.version], paths: [path] },
      ];
    }
  }
  return inventory;
}

const usage =
  'Usage: third-party-notices.mjs [--filter=WORKSPACE] [--deployed=NODE_MODULES] OUTPUT [OUTPUT...]';

export function parseNoticeArguments(args) {
  const filters = [];
  const outputs = [];
  let deployed;
  for (const arg of args) {
    if (arg.startsWith('--filter=')) filters.push(arg.slice('--filter='.length));
    else if (arg.startsWith('--deployed=') && !deployed) deployed = arg.slice('--deployed='.length);
    else if (arg.startsWith('--')) throw new Error(usage);
    else outputs.push(arg);
  }
  if (!outputs.length || filters.some((filter) => !filter.trim()) || deployed === '') {
    throw new Error(usage);
  }
  return { filters, outputs, deployed };
}

const pnpmJson = (args) =>
  JSON.parse(
    execFileSync('pnpm', args, {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );

async function main() {
  const { filters, outputs, deployed } = parseNoticeArguments(process.argv.slice(2));
  const inventory = pnpmJson([
    ...filters.flatMap((filter) => ['--filter', filter]),
    'licenses',
    'list',
    '--prod',
    '--json',
  ]);
  if (deployed) await addDeployedPackages(inventory, resolve(deployed));
  const workspacePackages = new Set(
    deployed
      ? pnpmJson(['ls', '--recursive', '--depth=-1', '--json']).map(
          (pkg) => `${pkg.name}@${pkg.version}`,
        )
      : [],
  );
  const content = [
    'WALDEN LICENSE AND ATTRIBUTION',
    await readFile(join(repository, 'LICENSE'), 'utf8'),
    await readFile(join(repository, 'NOTICE'), 'utf8'),
    await generateNotices(inventory, { workspacePackages }),
  ].join('\n');
  for (const output of outputs) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  console.log(`Wrote third-party notices to ${outputs.length} artifact(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
