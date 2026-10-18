import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('.', import.meta.url));
const destination = mkdtempSync(join(tmpdir(), 'walden-mastra-candidate-'));
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
Object.assign(manifest.dependencies, {
  '@mastra/core': '1.78.0',
  '@mastra/libsql': '1.26.2',
  '@mastra/pg': '1.31.2',
  '@mastra/redis': '1.4.10',
});
manifest.scripts = { test: 'node --test --test-concurrency=1 portability.test.mjs' };
writeFileSync(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const name of ['runtime.mjs', 'process.mjs', 'portability.test.mjs']) {
  copyFileSync(join(source, name), join(destination, name));
}
copyFileSync(join(source, 'candidate-lock.yaml'), join(destination, 'pnpm-lock.yaml'));
const env = {
  ...process.env,
  npm_config_cache: join(destination, '.npm-cache'),
  DO_NOT_TRACK: '1',
};
const installation = spawnSync('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile'], {
  cwd: destination,
  env,
  stdio: 'inherit',
});
if (installation.status !== 0) process.exit(installation.status ?? 1);
console.log(`Isolated candidate: ${destination}`);
if (!process.argv.includes('--prepare')) {
  // Forced takeover is used only AFTER the tests await the owner's SIGKILL exit.
  // Healthy-owner tests explicitly request ordinary, non-forced recovery.
  env.SPIKE_FORCE_RECOVERY = process.env.SPIKE_RECOVERY_WAIT_MS ? '0' : '1';
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...process.argv.slice(2), 'portability.test.mjs'],
    { cwd: destination, env, stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
