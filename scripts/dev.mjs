import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadEmbeddingModel } from '../apps/api/scripts/download-embedding-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function portNumber(name, value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be an integer from 1 to 65535`);
  return port;
}

export function developmentEnvironment(env = process.env, cloudflare = false) {
  const port = cloudflare ? 5173 : portNumber('PORT', env.PORT ?? 3000);
  const apiPort = cloudflare
    ? 8787
    : portNumber('WALDEN_API_PORT', env.WALDEN_API_PORT ?? port + 1);
  if (apiPort === port) throw new Error('PORT and WALDEN_API_PORT must be different');
  return {
    ...env,
    WALDEN_DEV_CLOUDFLARE: cloudflare ? '1' : '0',
    PORT: String(port),
    WALDEN_API_PORT: String(apiPort),
    APP_URL: cloudflare ? 'http://localhost:8787' : (env.APP_URL ?? `http://localhost:${port}`),
    HOST: env.HOST ?? '127.0.0.1',
    APP_ROOT: resolve(root, env.APP_ROOT ?? 'apps/api'),
    DATA_DIR: resolve(root, env.DATA_DIR ?? '.data'),
    EMBEDDING_MODEL_DIR: resolve(root, env.EMBEDDING_MODEL_DIR ?? '.cache/models/minilm'),
  };
}

export async function runPnpm(args, env) {
  const grouped = process.platform !== 'win32';
  const child = spawn('pnpm', args, { cwd: root, env, stdio: 'inherit', detached: grouped });
  let stopping = false;
  let timeout;
  const kill = (signal) => {
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = (signal) => {
    stopping = true;
    kill(signal);
    timeout ??= setTimeout(() => kill('SIGKILL'), 40_000).unref();
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    if (code !== 0 && !stopping) throw new Error(`pnpm ${args.join(' ')} failed`);
    return !stopping;
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

async function main() {
  process.chdir(root);
  const cloudflare = process.argv.includes('--cloudflare');
  const env = developmentEnvironment(process.env, cloudflare);
  if (!cloudflare) {
    console.info('Preparing local embedding model and Chromium (cached after the first run)…');
    if (!process.env.EMBEDDING_MODEL_DIR) await downloadEmbeddingModel(env.EMBEDDING_MODEL_DIR);
    if (
      !(await runPnpm(
        ['--filter', '@walden/api', 'exec', 'playwright', 'install', 'chromium'],
        env,
      ))
    )
      return;
  }
  if (!(await runPnpm(['exec', 'turbo', 'run', 'build', '--filter=@walden/web'], env))) return;
  await runPnpm(['exec', 'turbo', 'run', 'dev', '--env-mode=loose'], env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
