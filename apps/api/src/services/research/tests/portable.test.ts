import { expect, it, vi } from 'vitest';
import { createCloudflareSavedSources, createResearchTools } from '../research';

it('exposes portable browser tools independently of saved-source availability', async () => {
  const readMarkdown = vi.fn().mockResolvedValue('# Rendered');
  const env = {
    RESEARCH_BROWSER: {
      readMarkdown,
      listVisibleLinks: async () => [],
      screenshot: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' as const }),
    },
  };
  const tools = createResearchTools(env, 'owner', new AbortController().signal);
  expect(tools.readWebPage).toBeDefined();
  expect(tools.searchSources).toBeUndefined();
  const read = tools.readWebPage as unknown as {
    execute(input: { url: string }): Promise<unknown>;
  };
  expect(await read.execute({ url: 'https://example.com/' })).toMatchObject({
    markdown: '# Rendered',
    indexing: { status: 'unavailable' },
  });
});

it('exposes owner-scoped saved sources without requiring a browser', async () => {
  const search = vi.fn().mockResolvedValue({ query: 'topic', results: [] });
  const tools = createResearchTools(
    { SAVED_SOURCES: { upsert: vi.fn(), search, deleteOwner: vi.fn() } },
    'owner',
    new AbortController().signal,
  );
  expect(tools.readWebPage).toBeUndefined();
  const tool = tools.searchSources as unknown as {
    execute(input: { query: string }): Promise<unknown>;
  };
  await tool.execute({ query: 'topic' });
  expect(search).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{32}$/),
    'topic',
    expect.any(AbortSignal),
  );
});
it('deletes only matching owner metadata and owner-prefixed Cloudflare items', async () => {
  const remove = vi.fn();
  const list = vi.fn().mockResolvedValue({
    result: [
      { id: 'yes', key: 'owners/alice/page.md', metadata: { owner_scope: 'alice' } },
      { id: 'no', key: 'owners/bob/page.md', metadata: { owner_scope: 'bob' } },
      { id: 'wrong-prefix', key: 'owners/bob/page.md', metadata: { owner_scope: 'alice' } },
    ],
  });
  const sources = createCloudflareSavedSources({
    items: { list, delete: remove, upload: vi.fn() },
    search: vi.fn(),
  });
  await sources.deleteOwner('alice');
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({ metadata_filter: JSON.stringify({ owner_scope: 'alice' }) }),
  );
  expect(remove).toHaveBeenCalledExactlyOnceWith('yes');
});

it('collects every owner page within the Cloudflare API limit before deleting items', async () => {
  const remove = vi.fn();
  const item = (id: number): AiSearchItemInfo => ({
    id: String(id),
    status: 'completed',
    key: `owners/alice/${id}.md`,
    metadata: { owner_scope: 'alice' },
  });
  const list = vi.fn(async ({ page = 1, per_page = 50 }: AiSearchListItemsParams) => {
    if (per_page > 50) throw new Error('Cloudflare permits at most 50 items per page');
    expect(remove).not.toHaveBeenCalled();
    return { result: page === 1 ? Array.from({ length: 50 }, (_, id) => item(id)) : [item(50)] };
  });
  const sources = createCloudflareSavedSources({
    items: { list, delete: remove, upload: vi.fn() },
    search: vi.fn(),
  });
  await sources.deleteOwner('alice');
  expect(list).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, per_page: 50 }));
  expect(remove).toHaveBeenCalledTimes(51);
  expect(remove).toHaveBeenLastCalledWith('50');
});
