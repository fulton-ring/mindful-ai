import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectImageRoot } from './public-image-check.mjs';
import { generateNotices } from './third-party-notices.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'walden-licenses-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('notices preserve nested attribution, deduplicate peers, and omit installed paths', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'licenses'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }),
  );
  await writeFile(join(root, 'LICENSE'), 'MIT license\nCopyright Example');
  await writeFile(join(root, 'licenses', 'NOTICE.txt'), 'Nested attribution');
  await writeFile(join(root, 'license.d.ts'), 'not a license text');
  const entry = { name: 'example', paths: [root, root] };
  const result = await generateNotices({ MIT: [entry] });
  assert.match(result, /MIT license\nCopyright Example/);
  assert.match(result, /Nested attribution/);
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

async function imageFixture(t) {
  const root = await fixture(t);
  for (const path of ['public', 'models/minilm', 'node_modules/@mastra/core/dist']) {
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
