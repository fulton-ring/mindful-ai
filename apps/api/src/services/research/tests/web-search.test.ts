import { afterEach, expect, it, vi } from 'vitest';
import { createWebSearchTools } from '../web-search';

afterEach(() => vi.unstubAllGlobals());
const citation = (url: string, content = 'Public excerpt') => ({
  type: 'url_citation',
  url_citation: { url, title: 'Report', content },
});
function fixture(annotations: unknown[], searches = 1) {
  const fetcher = vi.fn().mockImplementation(() =>
    Response.json({
      choices: [{ message: { content: 'Unverified generated prose', annotations } }],
      usage: { server_tool_use_details: { web_search_requests: searches } },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const tools = createWebSearchTools(
    { OPENROUTER_API_KEY: 'test-key' },
    new AbortController().signal,
  );
  const search = tools.searchWeb as unknown as {
    execute: (input: { query: string }) => Promise<unknown>;
  };
  return { fetcher, search };
}
it('returns source excerpts, excludes generated prose and unsafe URLs, and bounds provider work', async () => {
  const { search, fetcher } = fixture([
    citation('https://openai.com/report'),
    citation('http://127.0.0.1/private'),
  ]);
  expect(await search.execute({ query: 'OpenAI Hugging Face incident' })).toEqual({
    results: [{ url: 'https://openai.com/report', title: 'Report', text: 'Public excerpt' }],
  });
  const request = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
  expect(request.max_tool_calls).toBe(1);
  expect(request.tools[0].parameters.max_uses).toBe(1);
  expect(request.messages.at(-1).content).toBe('OpenAI Hugging Face incident');
});
it('treats missing search execution as failure rather than no matching reports', async () => {
  const { search } = fixture([], 0);
  await expect(search.execute({ query: 'latest report' })).rejects.toThrow(
    'Web search did not return verified search results',
  );
});
it('does not send recognizable credentials or email addresses to search', async () => {
  const { search, fetcher } = fixture([]);
  await expect(search.execute({ query: 'find jane@example.org' })).rejects.toThrow('private');
  expect(fetcher).not.toHaveBeenCalled();
});
it('caps search calls per turn and honors cancellation', async () => {
  const { search, fetcher } = fixture([]);
  await search.execute({ query: 'public topic' });
  await search.execute({ query: 'another public topic' });
  await expect(search.execute({ query: 'third' })).rejects.toThrow('limit');
  expect(fetcher).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  controller.abort();
  const tool = createWebSearchTools({ OPENROUTER_API_KEY: 'test' }, controller.signal)
    .searchWeb as unknown as typeof search;
  await expect(tool.execute({ query: 'public' })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not advertise search without credentials', () => {
  expect(createWebSearchTools({}, new AbortController().signal)).toEqual({});
});
it('retries once when the search provider fails upstream, and reports a second failure', async () => {
  const { search, fetcher } = fixture([citation('https://openai.com/report')]);
  const upstream = () =>
    Response.json({ error: { message: 'upstream returned 502' } }, { status: 502 });
  fetcher.mockImplementationOnce(upstream);
  expect(await search.execute({ query: 'public topic' })).toMatchObject({
    results: [{ url: 'https://openai.com/report' }],
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockImplementationOnce(upstream).mockImplementationOnce(upstream);
  await expect(search.execute({ query: 'another topic' })).rejects.toThrow('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(4);
});
