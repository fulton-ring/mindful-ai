import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectImageRoot } from './public-image-check.mjs';
import * as noticeCommand from './third-party-notices.mjs';

const { addDeployedPackages, generateNotices, parseNoticeArguments } = noticeCommand;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'walden-licenses-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('notice command scopes the production inventory with explicit workspace filters', () => {
  assert.equal(typeof parseNoticeArguments, 'function');
  assert.deepEqual(
    parseNoticeArguments([
      '--filter=@walden/api',
      '--filter=@walden/web',
      'out.txt',
      'public/out.txt',
    ]),
    {
      filters: ['@walden/api', '@walden/web'],
      outputs: ['out.txt', 'public/out.txt'],
      deployed: undefined,
    },
  );
  assert.deepEqual(parseNoticeArguments(['--deployed=/out/node_modules', 'out.txt']), {
    filters: [],
    outputs: ['out.txt'],
    deployed: '/out/node_modules',
  });
  for (const args of [
    [],
    ['--filter=', 'out.txt'],
    ['--unknown', 'out.txt'],
    ['--deployed=', 'out.txt'],
    ['--deployed=a', '--deployed=b', 'out.txt'],
  ]) {
    assert.throws(() => parseNoticeArguments(args), /Usage:/);
  }
});

test('notice command works with an empty pnpm store and preserves the normal output', async (t) => {
  const root = await fixture(t);
  const store = join(root, 'empty-store');
  await mkdir(store);
  const command = fileURLToPath(new URL('./third-party-notices.mjs', import.meta.url));
  const run = (output, env) => {
    const result = spawnSync(
      process.execPath,
      [command, '--filter=@walden/api', '--filter=@walden/web', output],
      { env, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  };
  const isolated = join(root, 'isolated.txt');
  run(isolated, { ...process.env, npm_config_store_dir: store });
  const normal = join(root, 'normal.txt');
  run(normal, process.env);
  const text = await readFile(isolated, 'utf8');
  assert.equal(text, await readFile(normal, 'utf8'));
  for (const name of ['react', '@mastra/core', '@walden/contracts', '@walden/domain'])
    assert.ok(text.includes(`Package: ${name}@`), `Missing production package ${name}`);
  assert.doesNotMatch(text, /^Package: @biomejs\/biome@/m);
  assert.doesNotMatch(text, /^MISSING_LICENSE_TEXT:/m);
  assert.deepEqual(await readdir(store), [], 'Notice generation must not populate the pnpm store');
});

test('installed inventory follows production trees, aliases and all peer contexts', async (t) => {
  const root = await realpath(await fixture(t));
  const pkg = async (directory, metadata) => {
    const path = join(root, directory);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify(metadata));
    return { path };
  };
  const app = await pkg('app', { name: 'app' });
  const shared = await pkg('shared', { name: 'shared', version: '1', license: { type: 'ISC' } });
  const peer1 = await pkg('peer1', { name: 'peer', version: '1', license: 'MIT' });
  const peer2 = await pkg('peer2', { name: 'peer', version: '1', license: 'MIT' });
  const workspace = await pkg('workspace', { name: '@walden/workspace', license: 'Apache-2.0' });
  const inventory = await noticeCommand.installedProductionInventory([
    {
      ...app,
      dependencies: {
        first: { ...peer1, deduped: true },
        alias: { ...peer2, dependencies: { workspace } },
        later: { ...peer1, dependencies: { shared } },
      },
    },
  ]);
  assert.deepEqual(inventory, {
    MIT: [
      { name: 'peer', versions: ['1'], paths: [peer1.path] },
      { name: 'peer', versions: ['1'], paths: [peer2.path] },
    ],
    'Apache-2.0': [{ name: '@walden/workspace', versions: [undefined], paths: [workspace.path] }],
    ISC: [{ name: 'shared', versions: ['1'], paths: [shared.path] }],
  });
});

test('installed inventory skips absent optional packages but rejects missing required packages', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'app');
  await mkdir(path);
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { required: '1' },
      optionalDependencies: { platform: '1' },
      peerDependenciesMeta: { optionalPeer: { optional: true }, required: { optional: true } },
    }),
  );
  const missing = { path: join(root, 'missing') };
  assert.deepEqual(
    await noticeCommand.installedProductionInventory([
      { path, dependencies: { platform: missing, optionalPeer: missing } },
    ]),
    {},
  );
  await assert.rejects(
    noticeCommand.installedProductionInventory([{ path, dependencies: { required: missing } }]),
    /Missing required production dependency: required/,
  );
  const broken = join(root, 'broken-optional');
  await mkdir(broken);
  await assert.rejects(
    noticeCommand.installedProductionInventory([
      { path, optionalDependencies: { platform: { path: broken } } },
    ]),
    /ENOENT/,
  );
});

test('notices preserve nested attribution, deduplicate peers, and omit installed paths', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'licenses'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }),
  );
  await writeFile(join(root, 'LICENSE'), 'MIT license\nCopyright Example');
  await writeFile(join(root, 'licenses', 'NOTICE.txt'), 'Nested attribution');
  await writeFile(join(root, 'ThirdPartyNotices.txt'), 'Bundled dependency notices');
  await writeFile(join(root, 'LICENSES.txt'), 'Additional upstream license texts');
  await writeFile(join(root, 'license.d.ts'), 'not a license text');
  const entry = { name: 'example', paths: [root, root] };
  const result = await generateNotices({ MIT: [entry] });
  assert.match(result, /MIT license\nCopyright Example/);
  assert.match(result, /Nested attribution/);
  assert.match(result, /Bundled dependency notices/);
  assert.match(result, /Additional upstream license texts/);
  assert.doesNotMatch(result, /not a license text/);
  assert.ok(!result.includes(root));
  assert.equal(result.match(/Package: example@1.0.0/g).length, 1);
  assert.equal(result, await generateNotices({ MIT: [entry] }));
});

test('packages without a license retain upstream README and explicitly flag missing text', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'missing', version: '2' }));
  await writeFile(join(root, 'README.md'), 'Upstream licensing information');
  const result = await generateNotices({ Unknown: [{ name: 'missing', paths: [root] }] });
  assert.match(result, /MISSING_LICENSE_TEXT: missing@2/);
  assert.match(result, /Upstream licensing information/);
});

test('deployed package stores add unlisted packages and workspace packages keep the project license', async (t) => {
  const root = await fixture(t);
  const store = join(root, 'node_modules', '.pnpm');
  const write = async (entry, name, metadata, files = {}) => {
    const path = join(store, entry, 'node_modules', name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, ...metadata }));
    for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text);
    return path;
  };
  const listedPath = await write(
    'listed@1.0.0',
    'listed',
    { version: '1.0.0', license: 'MIT' },
    {
      LICENSE: 'Listed license',
    },
  );
  await write(
    '@scope+deployed@2.0.0',
    '@scope/deployed',
    { version: '2.0.0', license: 'ISC' },
    {
      LICENSE: 'Deployed scoped license',
    },
  );
  await write(
    'legacy@3.0.0',
    'legacy',
    { version: '3.0.0', licenses: [{ type: 'BSD-2-Clause' }] },
    {
      'LICENSE.md': 'Legacy license',
    },
  );
  await write('unknown@4.0.0', 'unknown', { version: '4.0.0' });
  await write('@walden+contracts@0.0.0', '@walden/contracts', {
    version: '0.0.0',
    license: 'Apache-2.0',
  });
  const inventory = await addDeployedPackages(
    { MIT: [{ name: 'listed', versions: ['1.0.0'], paths: [listedPath] }] },
    join(root, 'node_modules'),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(inventory).map(([license, packages]) => [
        license,
        packages.map((pkg) => `${pkg.name}@${pkg.versions.join()}`).sort(),
      ]),
    ),
    {
      MIT: ['listed@1.0.0'],
      ISC: ['@scope/deployed@2.0.0'],
      'BSD-2-Clause': ['legacy@3.0.0'],
      Unknown: ['unknown@4.0.0'],
      'Apache-2.0': ['@walden/contracts@0.0.0'],
    },
  );
  const result = await generateNotices(inventory, {
    workspacePackages: new Set(['@walden/contracts@0.0.0']),
  });
  assert.equal(result.match(/Package: listed@1.0.0/g).length, 1);
  assert.match(result, /Package: @scope\/deployed@2.0.0\nDeclared license: ISC/);
  assert.match(result, /Deployed scoped license/);
  assert.match(result, /Package: @walden\/contracts@0.0.0[^=]+Walden repository LICENSE/);
  assert.doesNotMatch(result, /MISSING_LICENSE_TEXT: @walden\/contracts/);
  assert.match(result, /MISSING_LICENSE_TEXT: unknown@4.0.0/);
});

async function supplementFixture(t) {
  const root = await fixture(t);
  const pkg = join(root, 'package');
  const supplements = join(root, 'supplements');
  await mkdir(pkg);
  await mkdir(supplements);
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'supplemented', version: '1.0.0' }),
  );
  const text = 'MIT license\nCopyright Original Author\n';
  await writeFile(join(supplements, 'LICENSE'), text);
  const manifest = {
    'supplemented@1.0.0': {
      provenance: {
        registry: 'https://registry.npmjs.org/supplemented/1.0.0',
        gitHead: 'a'.repeat(40),
      },
      files: [
        {
          path: 'LICENSE',
          source: `https://raw.githubusercontent.com/example/package/${'a'.repeat(40)}/LICENSE`,
          sha256: createHash('sha256').update(text).digest('hex'),
        },
      ],
    },
  };
  await writeFile(join(supplements, 'manifest.json'), JSON.stringify(manifest));
  return { pkg, supplements, manifest, inventory: { MIT: [{ paths: [pkg] }] } };
}

test('exact-version supplements retain verified upstream text and provenance offline', async (t) => {
  const { inventory, supplements } = await supplementFixture(t);
  const result = await generateNotices(inventory, { supplementDirectory: supplements });
  assert.match(result, /Copyright Original Author/);
  assert.match(result, /https:\/\/raw\.githubusercontent\.com\/example\/package\//);
  assert.doesNotMatch(result, /MISSING_LICENSE_TEXT: supplemented/);
});

test('supplements support release commits resolved from parent metadata or an upstream tag', async (t) => {
  const { inventory, supplements, manifest } = await supplementFixture(t);
  manifest['supplemented@1.0.0'].provenance.resolvedCommit = 'a'.repeat(40);
  manifest['supplemented@1.0.0'].provenance.gitHead = null;
  await writeFile(join(supplements, 'manifest.json'), JSON.stringify(manifest));
  assert.doesNotMatch(
    await generateNotices(inventory, { supplementDirectory: supplements }),
    /MISSING_LICENSE_TEXT: supplemented/,
  );
});

test('supplements identify upstream base64 transport for reproducible source verification', async (t) => {
  const { inventory, supplements, manifest } = await supplementFixture(t);
  manifest['supplemented@1.0.0'].files[0].sourceEncoding = 'base64';
  await writeFile(join(supplements, 'manifest.json'), JSON.stringify(manifest));
  assert.match(
    await generateNotices(inventory, { supplementDirectory: supplements }),
    /Source encoding: base64/,
  );
});

test('canonical terms retain the exact published declaration and label their provenance', async (t) => {
  const { inventory, supplements, manifest } = await supplementFixture(t);
  const entry = manifest['supplemented@1.0.0'];
  delete entry.provenance.gitHead;
  entry.provenance.npmIntegrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  entry.notice = 'Canonical terms correspond to the exact published MIT declaration.';
  entry.files[0].canonicalTerms = true;
  const declaration = JSON.stringify({
    name: 'supplemented',
    version: '1.0.0',
    license: 'MIT',
    author: 'Original Author',
  });
  await writeFile(join(supplements, 'declaration.json'), declaration);
  entry.files.push({
    path: 'declaration.json',
    source: 'https://registry.npmjs.org/supplemented/-/supplemented-1.0.0.tgz',
    sourceArchiveMember: 'package/package.json',
    sha256: createHash('sha256').update(declaration).digest('hex'),
  });
  await writeFile(join(supplements, 'manifest.json'), JSON.stringify(manifest));
  const result = await generateNotices(inventory, { supplementDirectory: supplements });
  assert.match(result, /Supplement context: Canonical terms correspond/);
  assert.match(result, /Canonical license terms \(reference text/);
  assert.match(result, /Source archive member: package\/package.json/);
  assert.ok(result.includes(declaration));
  assert.doesNotMatch(result, /MISSING_LICENSE_TEXT: supplemented/);
});

test('supplements never cover a different package version', async (t) => {
  const { pkg, inventory, supplements } = await supplementFixture(t);
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'supplemented', version: '1.0.1' }),
  );
  assert.match(
    await generateNotices(inventory, { supplementDirectory: supplements }),
    /MISSING_LICENSE_TEXT: supplemented@1.0.1/,
  );
});

test('supplements reject missing license files and checksum mismatches', async (t) => {
  const { inventory, supplements } = await supplementFixture(t);
  await writeFile(join(supplements, 'LICENSE'), 'modified');
  await assert.rejects(
    generateNotices(inventory, { supplementDirectory: supplements }),
    /checksum.*supplemented@1.0.0/i,
  );
  await rm(join(supplements, 'LICENSE'));
  await assert.rejects(generateNotices(inventory, { supplementDirectory: supplements }), /ENOENT/);
});

test('supplements reject paths outside their directory and missing provenance', async (t) => {
  const { inventory, supplements, manifest } = await supplementFixture(t);
  manifest['supplemented@1.0.0'].files[0].path = '../LICENSE';
  await writeFile(join(supplements, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(
    generateNotices(inventory, { supplementDirectory: supplements }),
    /Invalid.*supplement/i,
  );
  manifest['supplemented@1.0.0'].files[0].path = 'LICENSE';
  delete manifest['supplemented@1.0.0'].provenance;
  await writeFile(join(supplements, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(
    generateNotices(inventory, { supplementDirectory: supplements }),
    /Invalid.*supplement/i,
  );
});

test('AMD64 LZMA 1.5.1 retains its exact published MIT declaration and reference terms', async (t) => {
  const root = await fixture(t);
  const pkg = { name: '@napi-rs/lzma-linux-x64-gnu', version: '1.5.1', license: 'MIT' };
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  const inventory = { MIT: [{ paths: [root] }] };
  const result = await generateNotices(inventory);
  assert.doesNotMatch(result, /MISSING_LICENSE_TEXT: @napi-rs\/lzma-linux-x64-gnu@1\.5\.1/);
  assert.match(result, /Package: @napi-rs\/lzma-linux-x64-gnu@1\.5\.1/);
  assert.match(result, /Source archive member: package\/package.json/);
  assert.match(
    result,
    /Canonical license terms \(reference text; not a package-authored license file\)/,
  );
  assert.match(result, /no copyright holder or year has been invented/);
  assert.match(result, /578e2a50ae69cd627c2953f8fa677efbf89f3087efeafff2db65aa31b81dc136/);
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...pkg, version: '1.5.2' }));
  assert.match(
    await generateNotices(inventory),
    /MISSING_LICENSE_TEXT: @napi-rs\/lzma-linux-x64-gnu@1\.5\.2/,
  );
});

test('all checked-in supplements generate offline with valid provenance and checksums', async (t) => {
  const root = await fixture(t);
  const manifest = JSON.parse(
    await readFile(new URL('../licenses/npm/manifest.json', import.meta.url), 'utf8'),
  );
  assert.ok(Object.keys(manifest).length > 0, 'The release must retain its verified supplements');
  const packages = [];
  for (const [index, identity] of Object.keys(manifest).entries()) {
    const separator = identity.lastIndexOf('@');
    const path = join(root, String(index));
    await mkdir(path);
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({
        name: identity.slice(0, separator),
        version: identity.slice(separator + 1),
      }),
    );
    packages.push({ paths: [path] });
  }
  const result = await generateNotices({ 'Supplemented upstream license': packages });
  assert.doesNotMatch(result, /MISSING_LICENSE_TEXT: /);
});

async function imageFixture(t) {
  const root = await fixture(t);
  for (const path of [
    'public',
    'models/minilm',
    'node_modules/@mastra/core/dist',
    'node_modules/.pnpm',
    'notices',
  ]) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of [
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
  ]) {
    await writeFile(join(root, path), 'retained attribution');
  }
  return root;
}

test('image guard reports bundled Mastra files while rejecting unresolved/missing notices', async (t) => {
  const root = await imageFixture(t);
  assert.deepEqual(await inspectImageRoot(root), { issues: [], warnings: [] });
  await writeFile(join(root, 'node_modules/@mastra/core/dist/ee-example.js'), 'enterprise');
  await mkdir(join(root, 'node_modules/another-package/ee'), { recursive: true });
  await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'MISSING_LICENSE_TEXT: missing@2');
  await rm(join(root, 'models/minilm/LICENSE'));
  const { issues, warnings } = await inspectImageRoot(root);
  assert.ok(warnings.some((warning) => warning.includes('ee-example.js')));
  assert.ok(issues.every((issue) => !issue.includes('ee-example.js')));
  assert.ok(issues.some((issue) => issue.includes('another-package/ee')));
  assert.ok(issues.some((issue) => issue.includes('MISSING_LICENSE_TEXT')));
  assert.ok(issues.some((issue) => issue.includes('models/minilm/LICENSE')));
  assert.equal(
    await readFile(join(root, 'node_modules/@mastra/core/dist/ee-example.js'), 'utf8'),
    'enterprise',
  );
});

test('image guard does not mistake the MIT ee-first package for enterprise code', async (t) => {
  const root = await imageFixture(t);
  await mkdir(join(root, 'node_modules/ee-first'));
  await writeFile(join(root, 'node_modules/ee-first/index.js'), 'MIT licensed helper');
  assert.deepEqual(await inspectImageRoot(root), { issues: [], warnings: [] });
});

test('image guard rejects a release missing its native inventory', async (t) => {
  const root = await imageFixture(t);
  await rm(join(root, 'notices/debian-packages.tsv'));
  assert.deepEqual((await inspectImageRoot(root)).issues, [
    'Missing attribution artifact: notices/debian-packages.tsv',
  ]);
});

test('image guard checks the actual deployed package versions against retained notices', async (t) => {
  const root = await imageFixture(t);
  const pkg = join(root, 'node_modules/.pnpm/example@2.0.0/node_modules/example');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'example', version: '2.0.0' }));
  await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'Package: example@1.0.0\n');
  assert.ok(
    (await inspectImageRoot(root)).issues.includes(
      'Runtime package absent from notices: example@2.0.0',
    ),
  );
  await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'Package: example@2.0.0\n');
  assert.deepEqual((await inspectImageRoot(root)).issues, []);
});

test('bundled Mastra enterprise files alone do not fail the image-check command', async (t) => {
  const root = await imageFixture(t);
  await mkdir(join(root, 'node_modules/@mastra/core/dist/auth/ee'), { recursive: true });
  await writeFile(join(root, 'node_modules/@mastra/core/dist/ee-example.js'), 'bundled helper');
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./public-image-check.mjs', import.meta.url)), '--root', root],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Bundled Mastra enterprise file.*ee-example\.js/);
  assert.match(result.stderr, /Bundled Mastra enterprise file.*auth\/ee/);
});
