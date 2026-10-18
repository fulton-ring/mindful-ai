import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: 30_000 });

test('Compose starts runtime roles directly after healthy shared services', () => {
  const { services } = JSON.parse(
    run('docker', [
      'compose',
      '--env-file',
      '/dev/null',
      '--profile',
      'postgres',
      'config',
      '--format',
      'json',
    ]),
  );
  assert.equal(Object.hasOwn(services, 'migrate'), false);
  for (const role of ['http', 'worker', 'scheduler']) {
    assert.equal(services[role].environment.APP_ROLE, role);
    assert.equal(services[role].depends_on.migrate, undefined);
    for (const dependency of ['postgres', 'valkey', 'seaweedfs'])
      assert.equal(services[role].depends_on[dependency].condition, 'service_healthy');
  }
});

test('Helm validates and renders runtime deployments without a migration Job or hook', () => {
  const chart = 'deploy/helm/walden';
  const values = [
    '--set',
    'image.repository=walden-test',
    '--set',
    'image.tag=fixture',
    '--set',
    'externalSecretName=fixture',
    '--set',
    'config.APP_URL=http://localhost',
    '--set',
    'config.S3_ENDPOINT=http://fixture:9000',
    '--set',
    'config.S3_PUBLIC_ENDPOINT=http://localhost:9000',
    '--set',
    'config.S3_BUCKET=fixture',
  ];
  run('helm', ['lint', chart, ...values]);
  const rendered = run('helm', ['template', 'walden-test', chart, ...values]);
  assert.equal((rendered.match(/^kind: Deployment$/gm) ?? []).length, 3);
  assert.equal(/^kind: Job$/m.test(rendered), false);
  assert.equal(/helm\.sh\/hook/.test(rendered), false);
  assert.equal((rendered.match(/startupProbe:/g) ?? []).length, 3);
});
