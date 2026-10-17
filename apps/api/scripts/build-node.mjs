import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

await build({
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
    '@walden/contracts': resolve('../../packages/contracts/src/index.ts'),
    '@walden/domain': resolve('../../packages/domain/src/index.ts'),
  },
  sourcemap: true,
});
await mkdir('public', { recursive: true });
await cp('../web/dist', 'public', { recursive: true });
