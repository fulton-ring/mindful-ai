import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only against the disposable Compose project described in README.md.
const api = fileURLToPath(new URL('../../../apps/api/', import.meta.url));
const requireApi = createRequire(join(api, 'package.json'));
const { build } = requireApi('esbuild');
const { S3Client, HeadBucketCommand } = requireApi('@aws-sdk/client-s3');
const endpoint = process.env.WALDEN_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:18333';
const parsed = new URL(endpoint);
assert(['127.0.0.1', 'localhost'].includes(parsed.hostname), 'Use a disposable loopback endpoint');
const origin = 'http://localhost:3000';
const bucket = 'walden';
const config = {
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  bucket,
  credentials: {
    accessKeyId: process.env.SEAWEEDFS_ACCESS_KEY_ID ?? 'walden-local',
    secretAccessKey: process.env.SEAWEEDFS_SECRET_ACCESS_KEY ?? 'walden-local-password',
  },
};
const directory = await mkdtemp(join(tmpdir(), 'walden-seaweed-contract-'));
const sdk = new S3Client({ ...config, requestChecksumCalculation: 'WHEN_REQUIRED' });
try {
  const output = join(directory, 'store.cjs');
  await build({
    entryPoints: [join(api, 'src/storage/s3.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent',
  });
  const { createS3ObjectStore } = createRequire(import.meta.url)(output);
  const store = createS3ObjectStore(config);
  let lastError;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      await sdk.send(new HeadBucketCommand({ Bucket: bucket }));
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (lastError) throw lastError;
  const prefix = process.env.WALDEN_TEST_S3_PREFIX ?? `contract/${randomUUID()}/`;
  const persistentKey = `${prefix}persistent.txt`;
  if (process.argv.includes('--verify-persistence')) {
    assert.equal(await (await store.get(persistentKey))?.text(), 'persistent SeaweedFS object');
    await store.delete(persistentKey);
    console.log('SeaweedFS named-volume restart persistence PASS');
  } else {
    const staging = `${prefix}staging/upload.txt`;
    const final = `${prefix}owner/threads/thread/upload.txt`;
    const sidecar = `${final}.md`;
    const body = 'SeaweedFS signed nonempty upload — violet otter 731';
    const url = await store.presignPut(staging, 'text/plain', 120);
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '120');
    assert(!new URL(url).searchParams.has('x-amz-checksum-crc32'));
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert(preflight.ok);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const disallowed = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://other.example',
        'Access-Control-Request-Method': 'PUT',
      },
    });
    assert.notEqual(disallowed.headers.get('access-control-allow-origin'), 'https://other.example');
    const uploaded = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', Origin: origin },
      body,
    });
    assert(uploaded.ok, `Presigned upload: ${uploaded.status} ${await uploaded.text()}`);
    assert.equal((await store.head(staging))?.size, Buffer.byteLength(body));
    assert.equal(await (await store.get(staging))?.text(), body);
    for (const [path, method] of [
      ['', 'GET'],
      [staging, 'GET'],
      [`${prefix}anonymous.txt`, 'PUT'],
    ]) {
      const anonymous = await fetch(`${endpoint}/${bucket}/${path}`, { method });
      assert.equal(anonymous.status, 403, `Anonymous ${method} must be denied`);
      await anonymous.body?.cancel();
    }
    const unauthorized = new S3Client({
      ...config,
      credentials: { accessKeyId: 'wrong-key', secretAccessKey: 'wrong-secret' },
    });
    try {
      await assert.rejects(
        unauthorized.send(new HeadBucketCommand({ Bucket: bucket })),
        (error) => error.$metadata?.httpStatusCode === 403,
      );
    } finally {
      unauthorized.destroy();
    }
    const saved = await store.put(final, body, {
      customMetadata: { name: 'résumé-日本語.txt', owner: 'owner' },
      httpMetadata: { contentType: 'text/plain', cacheControl: 'private, no-store' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    assert(saved);
    assert.equal((await store.head(final))?.customMetadata?.name, 'résumé-日本語.txt');
    assert.equal((await store.head(final))?.httpMetadata?.cacheControl, 'private, no-store');
    assert.equal(await store.put(final, 'wrong', { onlyIf: { etagDoesNotMatch: '*' } }), null);
    assert.equal(await store.put(final, 'wrong', { onlyIf: { etagMatches: 'wrong-etag' } }), null);
    assert(await store.put(final, body, { onlyIf: { etagMatches: saved.etag } }));
    await store.put(sidecar, '# Extracted sidecar');
    const page = await store.list({ prefix, limit: 1 });
    assert.equal(page.objects.length, 1);
    assert(page.truncated && page.cursor);
    const next = await store.list({ prefix, cursor: page.cursor, include: ['customMetadata'] });
    assert(next.objects.length >= 2);
    assert(next.objects.every((object) => object.key.startsWith(prefix)));
    await store.delete([staging, final, sidecar]);
    assert.equal(await store.head(staging), null);
    assert.equal(await store.get(final), null);
    assert.equal((await store.list({ prefix })).objects.length, 0);
    await store.put(persistentKey, 'persistent SeaweedFS object');
    console.log(
      JSON.stringify({
        result: 'PASS',
        checks: [
          'presign-put-get',
          'private-anonymous-denial',
          'wrong-credential-denial',
          'origin-cors',
          'unicode-metadata',
          'conditional-put',
          'paginated-list',
          'batch-delete',
        ],
        persistencePrefix: prefix,
      }),
    );
  }
} finally {
  sdk.destroy();
  await rm(directory, { recursive: true, force: true });
}
