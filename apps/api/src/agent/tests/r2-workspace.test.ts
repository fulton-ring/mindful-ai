import { createWorkspaceTools, Workspace } from '@mastra/core/workspace';
import { expect, it } from 'vitest';
import { R2WorkspaceFilesystem } from '../r2-workspace';

const id = '00112233-4455-6677-8899-aabbccddeeff';
const prefix = 'owners/owner/threads/thread/attachments/';
const files = new Map([
  [id, { name: 'notes.md', type: 'text/markdown', text: 'Calibration phrase: coral ibex 284' }],
  [
    `${id}.md`,
    { name: 'paper.pdf.md', type: 'text/markdown', text: 'PDF phrase: violet otter 731' },
  ],
]);
const bucket = {
  async head(key: string) {
    const file = files.get(key.slice(prefix.length));
    return (
      file && {
        size: file.text.length,
        customMetadata: { name: file.name },
        httpMetadata: { contentType: file.type },
        uploaded: new Date(),
      }
    );
  },
  async get(key: string) {
    const file = files.get(key.slice(prefix.length));
    return (
      file && {
        customMetadata: { name: file.name },
        arrayBuffer: async () => new TextEncoder().encode(file.text).buffer,
      }
    );
  },
  async list() {
    return {
      objects: [...files].map(([key, file]) => ({
        key: prefix + key,
        size: file.text.length,
        customMetadata: { name: file.name },
      })),
      truncated: false,
    };
  },
};

it('lets Mastra list and grep extension-aware R2 files and converted sidecars', async () => {
  const filesystem = new R2WorkspaceFilesystem(bucket as never, 'owner', 'thread');
  const tools = await createWorkspaceTools(new Workspace({ filesystem }));
  const grep = tools.mastra_workspace_grep as { execute: (args: unknown) => Promise<string> };
  const list = tools.mastra_workspace_list_files as { execute: (args: unknown) => Promise<string> };
  const stat = tools.mastra_workspace_file_stat as { execute: (args: unknown) => Promise<string> };
  const original = `/attachments/${id}.md`;
  const sidecar = `/attachments/${id}.pdf.md`;
  expect(await list.execute({ path: '/' })).toContain('attachments');
  expect(await list.execute({ path: '/attachments' })).toContain(`${id}.md`);
  expect(await stat.execute({ path: original })).toContain('file');
  expect((await filesystem.readdir('/attachments')).map(({ name }) => name)).toEqual([
    `${id}.md`,
    `${id}.pdf.md`,
  ]);
  expect((await filesystem.stat(original)).type).toBe('file');
  expect(await filesystem.readFile(original, { encoding: 'utf-8' })).toContain('coral ibex 284');
  expect(await grep.execute({ path: original, pattern: 'coral ibex' })).toContain('coral ibex 284');
  expect(await grep.execute({ path: sidecar, pattern: 'violet otter' })).toContain(
    'violet otter 731',
  );
});
