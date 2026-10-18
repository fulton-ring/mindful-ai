import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type ObjectMetadata,
  type ObjectStore,
  type ObjectValue,
  objectBytes,
  type PutObjectOptions,
  type StoredObject,
} from './object-store';

type RecordFile = Omit<ObjectMetadata, 'uploaded'> & { uploaded: string; bytes: string };
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
/** One atomic record holds both bytes and metadata. Keys never become filesystem paths. */
export class LocalObjectStore implements ObjectStore {
  readonly uploadMode = 'direct';
  private readonly directory: string;
  constructor(root: string) {
    let ancestor = resolve(root);
    const suffix: string[] = [];
    while (true) {
      try {
        ancestor = realpathSync(ancestor);
        break;
      } catch (error) {
        if (!missing(error)) throw error;
        suffix.unshift(ancestor.split('/').at(-1)!);
        ancestor = resolve(ancestor, '..');
      }
    }
    this.directory = join(ancestor, ...suffix, 'objects');
  }
  private name(key: string) {
    if (
      !key ||
      key.startsWith('/') ||
      key.includes('\\') ||
      key.split('/').some((s) => s === '.' || s === '..') ||
      /[\x00-\x1f]/.test(key)
    )
      throw new Error('Invalid object key');
    return createHash('sha256').update(key).digest('hex');
  }
  /** Cheap readiness after initialization; does not enumerate stored objects again. */
  async ready() {
    // Refuse symlinks in every ancestor, including a substituted volume root.
    const components = this.directory.split('/').filter(Boolean);
    let current = '/';
    for (const component of components) {
      current = join(current, component);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('Object storage cannot use symlinks');
      } catch (error) {
        if (!missing(error)) throw error;
        await mkdir(current).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('Object storage cannot use symlinks');
      }
    }
    let initialized = initializedRoots.get(this.directory);
    if (!initialized) {
      initialized = this.cleanupOrphans();
      initializedRoots.set(this.directory, initialized);
    }
    await initialized;
  }
  private async cleanupOrphans() {
    for (const name of await readdir(this.directory)) {
      if (name.endsWith('.tmp'))
        await unlink(join(this.directory, name)).catch((error) => {
          if (!missing(error)) throw error;
        });
    }
  }
  private async record(key: string): Promise<RecordFile | null> {
    const name = this.name(key);
    await this.ready();
    try {
      const handle = await open(
        join(this.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const item = JSON.parse(await handle.readFile('utf8')) as RecordFile;
        if (item.key !== key) throw new Error('Corrupt object metadata');
        return item;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  private metadata(record: RecordFile): ObjectMetadata {
    const { bytes: _, ...metadata } = record;
    return { ...metadata, uploaded: new Date(record.uploaded) };
  }
  async head(key: string) {
    const record = await this.record(key);
    return record ? this.metadata(record) : null;
  }
  async get(key: string): Promise<StoredObject | null> {
    const record = await this.record(key);
    if (!record) return null;
    const bytes = Buffer.from(record.bytes, 'base64');
    return {
      ...this.metadata(record),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      text: async () => bytes.toString('utf8'),
    };
  }
  async put(key: string, value: ObjectValue, options: PutObjectOptions = {}) {
    const name = this.name(key);
    await this.ready();
    const bytes = await objectBytes(value);
    const record: RecordFile = {
      key,
      size: bytes.byteLength,
      etag: createHash('sha256').update(bytes).digest('hex'),
      uploaded: new Date().toISOString(),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
      bytes: Buffer.from(bytes).toString('base64'),
    };
    const target = join(this.directory, name);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (options.onlyIf?.etagDoesNotMatch === '*') {
        try {
          await link(temp, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
          throw error;
        }
      } else {
        const release = await acquireLock(target);
        try {
          const prior = await this.head(key);
          const conditions = options.onlyIf;
          if (
            conditions?.etagMatches &&
            (conditions.etagMatches === '*' ? !prior : prior?.etag !== conditions.etagMatches)
          )
            return null;
          if (conditions?.etagDoesNotMatch && prior?.etag === conditions.etagDoesNotMatch)
            return null;
          await rename(temp, target);
        } finally {
          release();
        }
      }
      return this.metadata(record);
    } finally {
      await unlink(temp).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }
  async delete(keys: string | string[]) {
    await this.ready();
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      const target = join(this.directory, this.name(key));
      const release = await acquireLock(target);
      try {
        await unlink(target).catch((error) => {
          if (!missing(error)) throw error;
        });
      } finally {
        release();
      }
    }
  }
  async list(options: Parameters<ObjectStore['list']>[0] = {}) {
    await this.ready();
    const objects: ObjectMetadata[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const handle = await open(
        join(this.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((error) => {
        if (missing(error)) return null;
        throw error;
      });
      if (!handle) continue;
      try {
        const record = JSON.parse(await handle.readFile('utf8')) as RecordFile;
        if (record.key.startsWith(options.prefix ?? '')) objects.push(this.metadata(record));
      } finally {
        await handle.close();
      }
    }
    objects.sort((a, b) => a.key.localeCompare(b.key, 'en'));
    const after = options.cursor ? Buffer.from(options.cursor, 'base64url').toString() : '';
    const remaining = objects.filter((item) => !after || item.key.localeCompare(after, 'en') > 0);
    const page = remaining.slice(0, Math.max(1, Math.min(options.limit ?? 1000, 1000)));
    const truncated = remaining.length > page.length;
    return {
      objects: page,
      truncated,
      ...(truncated ? { cursor: Buffer.from(page.at(-1)!.key).toString('base64url') } : {}),
    };
  }
}
export function createLocalObjectStore(root: string): ObjectStore {
  return new LocalObjectStore(root);
}

// Local volumes support one process. Queues cover all store instances in that process
// without leaving lock files behind after a crash.
const locks = new Map<string, Promise<void>>();
async function acquireLock(key: string): Promise<() => void> {
  const prior = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await prior;
  return () => {
    release();
    if (locks.get(key) === current) locks.delete(key);
  };
}

const initializedRoots = new Map<string, Promise<void>>();
