import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { developmentEnvironment } from './dev.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('defaults to standalone loopback ports and repository-local state', () => {
  const env = developmentEnvironment({});
  assert.equal(env.PORT, '3000');
  assert.equal(env.WALDEN_API_PORT, '3001');
  assert.equal(env.APP_URL, 'http://localhost:3000');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.WALDEN_DEV_CLOUDFLARE, '0');
  assert.equal(env.DATA_DIR, resolve(root, '.data'));
  assert.equal(env.APP_ROOT, resolve(root, 'apps/api'));
  assert.equal(env.EMBEDDING_MODEL_DIR, resolve(root, '.cache/models/minilm'));
});

test('preserves configured inference and storage while deriving the internal API port', () => {
  const env = developmentEnvironment({
    PORT: '4300',
    DATA_DIR: '/tmp/walden-dev-fixture',
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'private-fixture-key',
  });
  assert.equal(env.WALDEN_API_PORT, '4301');
  assert.equal(env.APP_URL, 'http://localhost:4300');
  assert.equal(env.DATA_DIR, '/tmp/walden-dev-fixture');
  assert.equal(env.AI_PROVIDER, 'openrouter');
  assert.equal(env.OPENROUTER_API_KEY, 'private-fixture-key');
});

test('rejects invalid or conflicting ports before spawning processes', () => {
  assert.throws(() => developmentEnvironment({ PORT: 'invalid' }), /PORT/);
  assert.throws(() => developmentEnvironment({ PORT: '65535' }), /WALDEN_API_PORT/);
  assert.throws(
    () => developmentEnvironment({ PORT: '4300', WALDEN_API_PORT: '4300' }),
    /different/,
  );
});

test('preserves an explicit embedding model location without replacing its assets', () => {
  const env = developmentEnvironment({ EMBEDDING_MODEL_DIR: '/tmp/operator-model' });
  assert.equal(env.EMBEDDING_MODEL_DIR, '/tmp/operator-model');
});

test('keeps OpenRouter configuration loaded by the root Node dotenv launcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'walden-dev-env-'));
  try {
    const path = join(directory, '.env');
    await writeFile(
      path,
      'AI_PROVIDER=openrouter\nAI_MODEL=fixture/model\nOPENROUTER_API_KEY=fixture-key\n',
      { mode: 0o600 },
    );
    const env = { ...process.env };
    for (const name of ['AI_PROVIDER', 'AI_MODEL', 'OPENROUTER_API_KEY', 'PORT', 'WALDEN_API_PORT'])
      delete env[name];
    const code = `import { developmentEnvironment } from './scripts/dev.mjs';
      const env = developmentEnvironment();
      console.log(JSON.stringify([env.AI_PROVIDER, env.AI_MODEL, env.OPENROUTER_API_KEY === 'fixture-key']));`;
    const result = spawnSync(
      process.execPath,
      [`--env-file=${path}`, '--input-type=module', '-e', code],
      { cwd: root, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['openrouter', 'fixture/model', true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('selects the legacy Cloudflare ports and origin only when explicitly requested', () => {
  const env = developmentEnvironment({ PORT: '4300', APP_URL: 'http://localhost:4300' }, true);
  assert.equal(env.WALDEN_DEV_CLOUDFLARE, '1');
  assert.equal(env.PORT, '5173');
  assert.equal(env.WALDEN_API_PORT, '8787');
  assert.equal(env.APP_URL, 'http://localhost:8787');
});
