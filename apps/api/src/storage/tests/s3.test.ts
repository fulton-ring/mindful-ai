import { expect, it, vi } from 'vitest';
import { S3ObjectStore } from '../s3';

it('normalizes SDK bytes, metadata, conditional failures and pagination', async () => {
  const send = vi.fn(async (command) => {
    switch (command.constructor.name) {
      case 'GetObjectCommand':
        return {
          Body: { transformToWebStream: () => new Response('private').body },
          ContentLength: 7,
          ContentType: 'text/plain',
          Metadata: { name: 'notes.txt' },
          ETag: '"abc"',
          LastModified: new Date(0),
        };
      case 'HeadObjectCommand':
        throw Object.assign(new Error('Missing'), { $metadata: { httpStatusCode: 404 } });
      case 'PutObjectCommand':
        throw Object.assign(new Error('PreconditionFailed'), {
          $metadata: { httpStatusCode: 412 },
        });
      case 'ListObjectsV2Command':
        return {
          Contents: [{ Key: 'owners/a/one', Size: 7, ETag: '"abc"', LastModified: new Date(0) }],
          IsTruncated: true,
          NextContinuationToken: 'next',
        };
    }
  });
  const store = new S3ObjectStore({
    bucket: 'private',
    region: 'us-east-1',
    client: { send } as never,
  });
  const object = await store.get('owners/a/one');
  expect(await object?.text()).toBe('private');
  expect(object?.etag).toBe('abc');
  expect(object?.customMetadata?.name).toBe('notes.txt');
  expect(await store.head('missing')).toBeNull();
  expect(await store.put('one', 'x', { onlyIf: { etagDoesNotMatch: '*' } })).toBeNull();
  expect(send.mock.calls.at(-1)?.[0].input).toMatchObject({
    Bucket: 'private',
    Key: 'one',
    IfNoneMatch: '*',
  });
  expect(await store.list({ prefix: 'owners/a/' })).toMatchObject({
    cursor: 'next',
    truncated: true,
    objects: [{ key: 'owners/a/one', size: 7 }],
  });
});
it('signs a private staging PUT for 120 seconds with the declared content type', async () => {
  const store = new S3ObjectStore({
    bucket: 'private',
    region: 'us-east-1',
    endpoint: 'http://localhost:8333',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const url = new URL(await store.presignPut('staging/owner/threads/thread/id', 'text/plain'));
  expect(url.pathname).toBe('/private/staging/owner/threads/thread/id');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
});

it('uses a browser-reachable public endpoint only when signing uploads', async () => {
  const store = new S3ObjectStore({
    bucket: 'private',
    region: 'us-east-1',
    endpoint: 'http://seaweedfs:8333',
    publicEndpoint: 'http://localhost:18333',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const url = new URL(await store.presignPut('staging/owner/thread/id', 'text/plain'));
  expect(url.hostname).toBe('localhost');
  expect(url.port).toBe('18333');
  expect(url.pathname).toBe('/private/staging/owner/thread/id');
});

it('returns oversized staging metadata without reading or allocating its body', async () => {
  const read = vi.fn(async () => new Uint8Array(50_000_000));
  const stream = vi.fn(() => new ReadableStream<Uint8Array>());
  const send = vi.fn(async () => ({
    ContentLength: 50_000_000,
    Body: { transformToByteArray: read, transformToWebStream: stream },
  }));
  const store = new S3ObjectStore({
    bucket: 'private',
    region: 'us-east-1',
    client: { send } as never,
  });
  expect((await store.get('staging/large'))?.size).toBe(50_000_000);
  expect(read).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
});

it('allows a real nonempty PUT through a presigned URL without an empty-body checksum', async () => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url!, 'http://localhost');
    response.statusCode =
      url.searchParams.has('x-amz-checksum-crc32') || body !== 'hello' ? 400 : 200;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const store = new S3ObjectStore({
      bucket: 'private',
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const signed = await store.presignPut('staging/owner/thread/id', 'text/plain');
    expect(new URL(signed).searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(
      (
        await fetch(signed, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body: 'hello',
        })
      ).status,
    ).toBe(200);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('round-trips Unicode filenames through ASCII-safe S3 metadata without changing ASCII values', async () => {
  let metadata: Record<string, string> = {};
  const send = vi.fn(async (command) => {
    if (command.constructor.name === 'PutObjectCommand') {
      metadata = command.input.Metadata;
      return { ETag: '"etag"' };
    }
    return { Metadata: metadata };
  });
  const store = new S3ObjectStore({
    bucket: 'private',
    region: 'us-east-1',
    client: { send } as never,
  });
  const original = {
    name: '你好 résumé 📚.pdf',
    ascii: 'plain.txt',
    prefix: 'walden:utf8:literal',
  };
  await store.put('one', 'bytes', { customMetadata: original });
  expect(metadata.ascii).toBe('plain.txt');
  expect(Object.values(metadata).every((value) => /^[\x20-\x7e]*$/.test(value))).toBe(true);
  expect((await store.head('one'))?.customMetadata).toEqual(original);
});
