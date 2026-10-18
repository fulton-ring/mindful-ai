import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LocalObjectStore } from '../local';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'walden-files-'));
  roots.push(root);
  return { root, files: new LocalObjectStore(root) };
}
it('persists bytes and metadata atomically and supports private prefix pagination', async () => {
  const { root, files } = await store();
  const first = await files.put('owners/a/one', 'hello', {
    httpMetadata: { contentType: 'text/plain' },
    customMetadata: { name: 'one.txt' },
  });
  await files.put('owners/a/two', 'two');
  await files.put('owners/b/one', 'private');
  const reopened = new LocalObjectStore(root);
  const object = await reopened.get('owners/a/one');
  expect(await object?.text()).toBe('hello');
  expect(object?.customMetadata?.name).toBe('one.txt');
  expect(object?.etag).toBe(first?.etag);
  expect(object?.uploaded).toBeInstanceOf(Date);
  const page = await reopened.list({ prefix: 'owners/a/', limit: 1 });
  expect(page.objects).toHaveLength(1);
  expect(page.truncated).toBe(true);
  const next = await reopened.list({ prefix: 'owners/a/', limit: 1, cursor: page.cursor });
  expect(next.objects.map((o) => o.key)).toEqual(['owners/a/two']);
  expect(
    await reopened.put('owners/a/one', 'no', { onlyIf: { etagDoesNotMatch: '*' } }),
  ).toBeNull();
  expect(await reopened.put('owners/a/one', 'no', { onlyIf: { etagMatches: 'wrong' } })).toBeNull();
  expect(
    await reopened.put('owners/a/one', 'updated', { onlyIf: { etagMatches: first!.etag } }),
  ).not.toBeNull();
  expect(
    await reopened.put('owners/a/one', 'any existing', { onlyIf: { etagMatches: '*' } }),
  ).not.toBeNull();
  expect(await reopened.put('missing', 'no', { onlyIf: { etagMatches: '*' } })).toBeNull();
  await reopened.delete(['owners/a/one', 'owners/a/two']);
  expect(await reopened.head('owners/a/one')).toBeNull();
});
it('has exactly one successful conditional creation during concurrent requests', async () => {
  const { root } = await store();
  const stores = Array.from({ length: 8 }, () => new LocalObjectStore(root));
  const results = await Promise.all(
    stores.map((files) => files.put('one', 'value', { onlyIf: { etagDoesNotMatch: '*' } })),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});
it('rejects traversal keys and symlinked storage directories', async () => {
  const { root, files } = await store();
  await expect(files.put('../outside', 'bad')).rejects.toThrow('key');
  const outside = await mkdtemp(join(tmpdir(), 'walden-outside-'));
  roots.push(outside);
  await symlink(outside, join(root, 'objects'));
  await expect(files.put('safe', 'bad')).rejects.toThrow('symlink');
});

it('ignores stale temporary and lock records after restarting local storage', async () => {
  const { root, files } = await store();
  await files.put('one', 'before');
  const { readdir, writeFile } = await import('node:fs/promises');
  const [name] = await readdir(join(root, 'objects'));
  await writeFile(join(root, 'objects', `${name}.lock`), 'stale');
  await writeFile(join(root, 'objects', `${name}.tmp`), 'stale');
  const reopened = new LocalObjectStore(root);
  await expect(reopened.put('one', 'after')).resolves.toMatchObject({ key: 'one' });
  expect((await reopened.list()).objects).toHaveLength(1);
});

it('keeps listing usable while objects are concurrently deleted', async () => {
  const { files } = await store();
  const keys = Array.from({ length: 100 }, (_, i) => `owners/a/${i}`);
  await Promise.all(keys.map((key) => files.put(key, 'x'.repeat(10000))));
  const results = await Promise.allSettled([
    files.list({ prefix: 'owners/a/' }),
    files.delete(keys),
  ]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
});

it('removes crash-left private temporary bytes before an owner purge starts', async () => {
  const { root, files } = await store();
  const { mkdir, writeFile, readdir } = await import('node:fs/promises');
  await mkdir(join(root, 'objects'));
  await writeFile(
    join(root, 'objects', `${'a'.repeat(64)}.${crypto.randomUUID()}.tmp`),
    'private owner bytes',
  );
  const { deleteAttachmentPrefix } = await import('../../chat/attachments/attachments');
  await deleteAttachmentPrefix(files, 'owner');
  expect(await readdir(join(root, 'objects'))).toEqual([]);
});
