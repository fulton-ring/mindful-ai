import { spawn } from 'node:child_process';
import { root } from './stacks.mjs';

async function run(args) {
  const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit', env: process.env });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) process.exit(code ?? 1);
}
const args = process.argv.slice(2);
if (!args.includes('--skip-build')) {
  await run(['run', 'build:self-hosted']);
  await run(['--filter', '@walden/api', 'build']);
}
await run([
  'exec',
  'playwright',
  'test',
  '--config',
  'tests/provider-matrix/playwright.config.ts',
  ...args.filter((arg) => arg !== '--skip-build'),
]);
