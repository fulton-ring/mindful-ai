import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));

export const nodeBuildOptions = {
  absWorkingDir: apiRoot,
  entryPoints: {
    server: 'src/platform/node/server.ts',
    cli: 'src/platform/node/cli.ts',
    'document-worker': 'src/platform/node/documents/worker.ts',
  },
  outdir: 'dist/node',
  platform: 'node',
  target: 'node24.15',
  format: 'esm',
  bundle: true,
  packages: 'external',
  alias: {
    '@walden/contracts': resolve(apiRoot, '../../packages/contracts/src/index.ts'),
    '@walden/domain': resolve(apiRoot, '../../packages/domain/src/index.ts'),
  },
  sourcemap: true,
};

export async function buildNode() {
  await build(nodeBuildOptions);
  await mkdir(resolve(apiRoot, 'public'), { recursive: true });
  await cp(resolve(apiRoot, '../web/dist'), resolve(apiRoot, 'public'), { recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildNode();
