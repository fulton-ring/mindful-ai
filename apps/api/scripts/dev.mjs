import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import { developmentEnvironment, runPnpm } from '../../../scripts/dev.mjs';
import { nodeBuildOptions } from './build-node.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

async function watchNative() {
  const env = developmentEnvironment();
  const build = await context(nodeBuildOptions);
  try {
    await build.rebuild();
    await build.watch();
    const child = spawn(process.execPath, ['--watch', 'scripts/start-self-hosted.mjs'], {
      cwd: root,
      env: { ...env, PORT: env.WALDEN_API_PORT },
      stdio: 'inherit',
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    try {
      const code = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      process.exitCode = code ?? 0;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    }
  } finally {
    await build.dispose();
  }
}

if (process.env.WALDEN_DEV_CLOUDFLARE === '1')
  await runPnpm(['--filter', '@walden/api', 'run', 'dev:cloudflare'], process.env);
else await watchNative();
