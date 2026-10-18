import { createWorkspaceTools } from '@mastra/core/workspace';
import { expect, it } from 'vitest';
import { createTurnWorkspace } from '../../services/agent/agent-stream';
import type { AgentTurnInput } from '../../services/types';
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

it('lists and searches extension-aware R2 files and converted sidecars under plain tool names', async () => {
  const filesystem = new R2WorkspaceFilesystem(bucket as never, 'owner', 'thread');
  const workspace = createTurnWorkspace({ FILES: bucket as never }, {
    ownerId: 'owner',
    conversation: { id: 'thread' },
  } as AgentTurnInput)!;
  const tools = await createWorkspaceTools(workspace);
  expect(Object.keys(tools).filter((name) => name.includes('mastra'))).toEqual([]);
  type Tool = { execute: (args: unknown) => Promise<string> };
  const grep = tools.searchFiles as Tool;
  const list = tools.listFiles as Tool;
  const stat = tools.fileInfo as Tool;
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

it('reports normal missing-file probes as ENOENT without accessing another path', async () => {
  const filesystem = new R2WorkspaceFilesystem(bucket as never, 'owner', 'thread');
  await expect(filesystem.readFile('/.gitignore')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(filesystem.stat('/attachments/../other')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await filesystem.exists('/.gitignore')).toBe(false);
});
