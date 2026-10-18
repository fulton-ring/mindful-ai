import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBuildOptions } from '../apps/api/scripts/build-node.mjs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { build } = require('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  ...nodeBuildOptions,
  absWorkingDir: root,
  entryPoints: ['tests/container/browser-smoke.ts'],
  outdir: undefined,
  outfile: resolve(process.argv[2] ?? '/tmp/walden-container-browser-smoke.mjs'),
  sourcemap: false,
});
