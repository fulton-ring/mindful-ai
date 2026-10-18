import {
  type FileEntry,
  type FileStat,
  MastraFilesystem,
  type ReadOptions,
} from '@mastra/core/workspace';
import { attachmentKey, attachmentWorkspacePath } from '../chat/attachments/attachments';
import type { ObjectStore } from '../storage/object-store';

/** Read-only view of one thread's private uploads for Mastra's native file tools. */
export class R2WorkspaceFilesystem extends MastraFilesystem {
  readonly id = 'walden-r2-files';
  readonly name = 'R2WorkspaceFilesystem';
  readonly provider = 'r2';
  readonly readOnly = true;
  status: 'pending' | 'ready' = 'pending';
  private readonly prefix: string;

  constructor(
    private readonly bucket: ObjectStore,
    ownerId: string,
    conversationId: string,
  ) {
    super({ name: 'R2WorkspaceFilesystem' });
    this.prefix = attachmentKey(ownerId, conversationId, '');
  }

  getInstructions() {
    return 'User attachments are in /attachments. Read or grep text files as needed. For a PDF, DOCX, or XLSX, call extractDocument first, then read or grep its returned Markdown path. Images can be viewed as media.';
  }

  private notFound(): Error {
    return Object.assign(new Error('Attachment not found'), { code: 'ENOENT' });
  }

  private key(path: string): string {
    const match = /^\/?attachments\/([a-f0-9-]{36})(\.[a-z0-9]+(?:\.[a-z0-9]+)?)?$/.exec(path);
    if (!match) throw this.notFound();
    const [, id, extension] = match;
    return this.prefix + id + (/^\.(pdf|docx|xlsx)\.md$/.test(extension ?? '') ? '.md' : '');
  }

  private pathForObject(key: string, name: string): string {
    const suffix = key.slice(this.prefix.length);
    const sidecar = suffix.endsWith('.md') && /^[a-f0-9-]{36}\.md$/.test(suffix);
    const id = sidecar ? suffix.slice(0, -3) : suffix;
    if (sidecar) {
      const extension = /\.(pdf|docx|xlsx)\.md$/i.exec(name)?.[1]?.toLowerCase();
      if (extension) return `/attachments/${id}.${extension}.md`;
    }
    return attachmentWorkspacePath(id, name);
  }

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const object = await this.bucket.get(this.key(path));
    if (!object) throw this.notFound();
    if (this.pathForObject(this.key(path), object.customMetadata?.name ?? '') !== path)
      throw this.notFound();
    const bytes = Buffer.from(await object.arrayBuffer());
    return options?.encoding ? bytes.toString(options.encoding) : bytes;
  }

  async exists(path: string): Promise<boolean> {
    if (path === '/' || path === '.' || path === '/attachments') return true;
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat> {
    if (path === '/' || path === '.' || path === '/attachments')
      return {
        name: path === '/attachments' ? 'attachments' : '.',
        path,
        type: 'directory',
        size: 0,
        createdAt: new Date(0),
        modifiedAt: new Date(0),
      };
    const object = await this.bucket.head(this.key(path));
    if (!object) throw this.notFound();
    if (this.pathForObject(this.key(path), object.customMetadata?.name ?? '') !== path)
      throw this.notFound();
    return {
      name: object.customMetadata?.name ?? path.split('/').at(-1) ?? 'attachment',
      path,
      type: 'file',
      size: object.size,
      createdAt: object.uploaded,
      modifiedAt: object.uploaded,
      mimeType: object.httpMetadata?.contentType,
    };
  }

  async readdir(path: string): Promise<FileEntry[]> {
    if (path === '/' || path === '.') return [{ name: 'attachments', type: 'directory' }];
    if (path !== '/attachments') throw new Error('Directory not found');
    const files: FileEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: this.prefix,
        cursor,
        include: ['customMetadata'],
      });
      files.push(
        ...page.objects.map((object) => ({
          name: this.pathForObject(object.key, object.customMetadata?.name ?? '').slice(
            '/attachments/'.length,
          ),
          type: 'file' as const,
          size: object.size,
        })),
      );
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return files;
  }

  async writeFile(): Promise<void> {
    throw new Error('Attachments are read-only');
  }
  async appendFile(): Promise<void> {
    throw new Error('Attachments are read-only');
  }
  async deleteFile(): Promise<void> {
    throw new Error('Attachments are read-only');
  }
  async copyFile(): Promise<void> {
    throw new Error('Attachments are read-only');
  }
  async moveFile(): Promise<void> {
    throw new Error('Attachments are read-only');
  }
  async mkdir(): Promise<void> {
    throw new Error('Attachments are read-only');
  }
  async rmdir(): Promise<void> {
    throw new Error('Attachments are read-only');
  }
}
