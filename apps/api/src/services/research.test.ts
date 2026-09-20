import { describe, expect, it, vi } from 'vitest';

import { createResearchTools, type ResearchEnv } from './research';

type ExecutableTool = { execute: (input: Record<string, string>) => Promise<unknown> };

function fixture() {
  const upload = vi.fn().mockResolvedValue({ id: 'item-1', status: 'queued' });
  const search = vi.fn().mockResolvedValue({ search_query: 'workers', chunks: [] });
  const quickAction = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true, result: '# Cloudflare\n\nWorkers' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const env = {
    BROWSER: { quickAction },
    AI_SEARCH: { get: vi.fn(() => ({ items: { upload }, search })) },
    AI_SEARCH_INSTANCE: 'research',
  } as unknown as ResearchEnv;
  const tools = createResearchTools(env, 'user_123', new AbortController().signal);
  return {
    read: tools.readWebPage as unknown as ExecutableTool,
    searchTool: tools.searchSources as unknown as ExecutableTool,
    quickAction,
    upload,
    search,
    env,
  };
}

describe('createResearchTools', () => {
  it('uses the authenticated REST transport with Worker-compatible redirect handling', async () => {
    const { env, quickAction, upload } = fixture();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: '# Example' })))
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { id: 'rest-item', status: 'queued' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    try {
      const signal = new AbortController().signal;
      const tools = createResearchTools(
        { ...env, CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'test-token' },
        'owner',
        signal,
      );
      await (tools.readWebPage as unknown as ExecutableTool).execute({
        url: 'https://example.com/',
      });
      expect(quickAction).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/account/browser-rendering/markdown',
        expect.objectContaining({ method: 'POST', redirect: 'manual', signal }),
      );
      expect(fetcher).toHaveBeenNthCalledWith(
        2,
        'https://api.cloudflare.com/client/v4/accounts/account/ai-search/namespaces/default/instances/research/items',
        expect.objectContaining({ method: 'POST', redirect: 'manual', signal }),
      );
      const uploadRequest = fetcher.mock.calls[1]?.[1] as RequestInit;
      const form = uploadRequest.body as FormData;
      expect(JSON.parse(String(form.get('metadata')))).toEqual({
        owner_scope: expect.stringMatching(/^[a-f0-9]{32}$/),
        source_url: 'https://example.com/',
      });
      expect((form.get('file') as File).name).toMatch(/^owners\/[a-f0-9]{32}\/[a-f0-9]{32}\.md$/);
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('distinguishes upload permission failure from a successful page read', async () => {
    const { env } = fixture();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ success: true, result: '# Example Domain' }))
        .mockResolvedValueOnce(
          Response.json(
            { success: false, errors: [{ message: 'private upstream details' }] },
            { status: 403 },
          ),
        ),
    );
    try {
      const tools = createResearchTools(
        { ...env, CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'test-token' },
        'owner',
        new AbortController().signal,
      );
      const result = await (tools.readWebPage as unknown as ExecutableTool).execute({
        url: 'https://example.com/',
      });
      expect(result).toMatchObject({
        markdown: '# Example Domain',
        indexing: { status: 'failed', reason: 'permission_denied' },
      });
      expect(JSON.stringify(result)).not.toContain('private upstream details');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('searches the configured REST instance with the same owner-scoped retrieval request', async () => {
    const { env, search } = fixture();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('owner'));
    const ownerScope = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: {
          search_query: 'workers',
          chunks: [
            {
              id: 'chunk',
              type: 'text',
              score: 0.8,
              text: 'Workers content',
              item: {
                key: 'page.md',
                metadata: {
                  owner_scope: ownerScope,
                  source_url: 'https://example.com/source',
                },
              },
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const signal = new AbortController().signal;
      const tools = createResearchTools(
        { ...env, CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'test-token' },
        'owner',
        signal,
      );
      const result = await (tools.searchSources as unknown as ExecutableTool).execute({
        query: 'workers',
      });

      expect(fetcher).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/account/ai-search/namespaces/default/instances/research/search',
        expect.objectContaining({ method: 'POST', redirect: 'manual', signal }),
      );
      const request = fetcher.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(request.body))).toEqual({
        query: 'workers',
        ai_search_options: {
          retrieval: {
            max_num_results: 5,
            filters: { owner_scope: ownerScope },
            context_expansion: 0,
          },
        },
      });
      expect(result).toMatchObject({
        results: [{ text: 'Workers content', url: 'https://example.com/source' }],
      });
      expect(search).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads a public page and queues the bounded Markdown in owner-scoped storage', async () => {
    const { read, quickAction, upload } = fixture();

    const result = (await read.execute({ url: 'https://example.com/guide#intro' })) as {
      url: string;
      markdown: string;
      indexing: { status: string };
    };

    expect(quickAction).toHaveBeenCalledWith(
      'markdown',
      expect.objectContaining({
        url: 'https://example.com/guide',
        allowRequestPattern: ['^https://example\\.com(?:/|$)'],
      }),
    );
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toMatch(/^owners\/[a-f0-9]{32}\/[a-f0-9]{32}\.md$/);
    expect(upload.mock.calls[0]?.[1]).toBe('# Cloudflare\n\nWorkers');
    expect(upload.mock.calls[0]?.[2]).toEqual({
      metadata: {
        owner_scope: expect.stringMatching(/^[a-f0-9]{32}$/),
        source_url: 'https://example.com/guide',
      },
    });
    expect(result).toMatchObject({
      url: 'https://example.com/guide',
      markdown: '# Cloudflare\n\nWorkers',
      indexing: { status: 'queued' },
    });
  });

  it.each([
    'http://localhost/admin',
    'http://localhost./admin',
    'http://100.64.0.1/',
    'http://8.8.8.8/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://[::1]/',
    'file:///etc/passwd',
    'https://user:secret@example.com/',
  ])('rejects non-public destination %s before Browser Run', async (url) => {
    const { read, quickAction, upload } = fixture();
    await expect(read.execute({ url })).rejects.toThrow(/public|credentials/i);
    expect(quickAction).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('filters every search to the owner folder and returns bounded source-bearing chunks', async () => {
    const { searchTool, search } = fixture();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('user_123'));
    const ownerScope = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    search.mockResolvedValue({
      search_query: 'workers',
      chunks: [
        {
          id: 'chunk-1',
          type: 'text',
          score: 0.92,
          text: 'x'.repeat(5_000),
          item: {
            key: 'ignored.md',
            metadata: { owner_scope: ownerScope, source_url: 'https://example.com/guide' },
          },
        },
      ],
    });

    const result = (await searchTool.execute({ query: 'workers' })) as {
      results: Array<{ text: string; url?: string }>;
    };
    expect(search).toHaveBeenCalledWith({
      query: 'workers',
      ai_search_options: {
        retrieval: {
          max_num_results: 5,
          filters: { owner_scope: expect.stringMatching(/^[a-f0-9]{32}$/) },
          context_expansion: 0,
        },
      },
    });
    expect(result.results[0]).toEqual({
      text: 'x'.repeat(4_000),
      score: 0.92,
      url: 'https://example.com/guide',
    });
  });

  it('honors cancellation before making a binding call', async () => {
    const controller = new AbortController();
    controller.abort();
    const quickAction = vi.fn();
    const env = {
      BROWSER: { quickAction },
      AI_SEARCH: { get: vi.fn(() => ({ items: { upload: vi.fn() }, search: vi.fn() })) },
      AI_SEARCH_INSTANCE: 'research',
    } as unknown as ResearchEnv;
    const { readWebPage } = createResearchTools(env, 'user_123', controller.signal);

    await expect(
      (readWebPage as unknown as ExecutableTool).execute({ url: 'https://example.com/' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(quickAction).not.toHaveBeenCalled();
  });

  it('does not expose provider error details', async () => {
    const { read, quickAction } = fixture();
    quickAction.mockRejectedValue(new Error('secret upstream detail'));
    await expect(read.execute({ url: 'https://example.com/' })).rejects.toThrow(
      'Reading the page failed. Please try again.',
    );
  });

  it('returns a successfully read page when background indexing cannot be queued', async () => {
    const { read, upload } = fixture();
    upload.mockRejectedValue(new Error('index unavailable'));

    await expect(read.execute({ url: 'https://example.com/' })).resolves.toMatchObject({
      markdown: '# Cloudflare\n\nWorkers',
      indexing: { status: 'failed' },
    });
  });
});
