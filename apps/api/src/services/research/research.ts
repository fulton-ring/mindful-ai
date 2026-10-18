import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { McpTools } from '../mcp';
import { createBrowserActions } from './browser-actions';
import type { ResearchBrowser, SavedSources } from './ports';

export type { ResearchBrowser, SavedSources } from './ports';

import {
  assertActive,
  boundedBytes,
  boundedJson,
  escapeRegex,
  publicUrl,
  within,
} from './research-common';

export { boundedJson, publicUrl } from './research-common';

const MAX_PAGE_CHARS = 12_000;
const MAX_INDEX_CHARS = 64_000;
const MAX_QUERY_CHARS = 500;
const MAX_RESULTS = 5;
const MAX_CHUNK_CHARS = 4_000;
const MAX_ITEMS_PER_PAGE = 50;

export type ResearchEnv = {
  RESEARCH_BROWSER?: ResearchBrowser;
  SAVED_SOURCES?: SavedSources;
  BROWSER?: BrowserRun;
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
};

class ResearchApiError extends Error {
  constructor(readonly status: number) {
    super('Cloudflare API request failed.');
  }
}

type ResearchInstance = {
  items: {
    list: (options: AiSearchListItemsParams) => Promise<AiSearchListItemsResponse>;
    delete: (id: string) => Promise<void>;
    upload: (
      name: string,
      content: string,
      options: { metadata: Record<string, unknown> },
    ) => Promise<AiSearchItemInfo>;
  };
  search: (request: AiSearchSearchRequest) => Promise<AiSearchSearchResponse>;
};

type CloudflareBrowser = {
  quickAction: BrowserRun['quickAction'];
};

async function cloudflareResult<T>(response: Response): Promise<T> {
  const envelope = await boundedJson(response);
  if (!response.ok || envelope.success !== true || envelope.result === undefined) {
    throw new ResearchApiError(response.status);
  }
  return envelope.result as T;
}

export async function researchOwnerScope(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function safeFailure(action: string, error: unknown): never {
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  console.info('Research failure', {
    action,
    name: error instanceof Error ? error.name : 'unknown',
  });
  throw new Error(`${action} failed. Please try again.`);
}

function createRestInstance(
  searchBase: string,
  apiHeaders: { Authorization: string },
  signal: AbortSignal,
): ResearchInstance {
  return {
    items: {
      list: async (options) => {
        const query = new URLSearchParams(
          Object.entries(options).map(([key, value]) => [key, String(value)]),
        );
        const response = await fetch(`${searchBase}/items?${query}`, {
          headers: apiHeaders,
          signal,
          redirect: 'manual',
        });
        return { result: await cloudflareResult<AiSearchItemInfo[]>(response) };
      },
      delete: async (id) => {
        const response = await fetch(`${searchBase}/items/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: apiHeaders,
          signal,
          redirect: 'manual',
        });
        await cloudflareResult<unknown>(response);
      },
      upload: async (name, content, options) => {
        const form = new FormData();
        form.append('file', new File([content], name, { type: 'text/markdown' }));
        form.append('metadata', JSON.stringify(options.metadata));
        const response = await fetch(`${searchBase}/items`, {
          method: 'POST',
          headers: apiHeaders,
          body: form,
          signal,
          redirect: 'manual',
        });
        return cloudflareResult<AiSearchItemInfo>(response);
      },
    },
    search: async (request) => {
      const response = await fetch(`${searchBase}/search`, {
        method: 'POST',
        headers: { ...apiHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
        redirect: 'manual',
      });
      return cloudflareResult<AiSearchSearchResponse>(response);
    },
  };
}

function createRestBrowser(
  apiBase: string,
  apiToken: string,
  signal: AbortSignal,
): CloudflareBrowser {
  return {
    quickAction: (action, options) =>
      fetch(`${apiBase}/browser-rendering/${action}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options),
        signal,
        redirect: 'manual',
      }),
  };
}

async function indexPage(
  instance: ResearchInstance,
  scope: string,
  sourceUrl: string,
  markdown: string,
  signal: AbortSignal,
): Promise<{ id?: string; status: string; reason?: string }> {
  const key = `owners/${scope}/${await researchOwnerScope(sourceUrl)}.md`;
  assertActive(signal);
  try {
    const item = await within(
      instance.items.upload(key, markdown, {
        metadata: { owner_scope: scope, source_url: sourceUrl },
      }),
      signal,
      10_000,
    );
    return { id: item.id, status: item.status };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return {
      status: 'failed',
      reason:
        error instanceof ResearchApiError && [401, 403].includes(error.status)
          ? 'permission_denied'
          : 'indexing_unavailable',
    };
  }
}

export function createCloudflareResearchBrowser(browser: CloudflareBrowser): ResearchBrowser {
  const options = (url: string) => ({
    url,
    allowRequestPattern: [`^${escapeRegex(new URL(url).origin)}(?:/|$)`],
    gotoOptions: { timeout: 15_000, waitUntil: 'domcontentloaded' as const },
  });
  async function action(name: 'markdown' | 'links', url: string, signal: AbortSignal) {
    const response = await within(
      name === 'links'
        ? browser.quickAction('links', { ...options(url), visibleLinksOnly: true })
        : browser.quickAction('markdown', options(url)),
      signal,
      20_000,
    );
    if (!response.ok) throw new Error('Browser Run rejected the page.');
    const body = await within(boundedJson(response), signal, 2_000);
    if (body.success !== true) throw new Error('Browser Run returned an invalid response.');
    return body.result;
  }
  return {
    async readMarkdown(url, signal) {
      const result = await action('markdown', url, signal);
      if (typeof result !== 'string') throw new Error('Invalid Markdown.');
      return result;
    },
    async listVisibleLinks(url, signal) {
      const result = await action('links', url, signal);
      if (!Array.isArray(result)) throw new Error('Invalid links.');
      return result.filter((value): value is string => typeof value === 'string');
    },
    async screenshot(url, signal) {
      const response = await within(
        browser.quickAction('screenshot', {
          ...options(url),
          viewport: { width: 1280, height: 720 },
          screenshotOptions: { type: 'jpeg', quality: 65 },
        }),
        signal,
        20_000,
      );
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg')
        throw new Error('Invalid screenshot.');
      return {
        bytes: await within(boundedBytes(response, 512_000), signal, 2_000),
        mimeType: 'image/jpeg',
      };
    },
  };
}

/** Keeps Cloudflare's existing request contract behind the same saved-source port. */
export function createCloudflareSavedSources(instance: ResearchInstance): SavedSources {
  return {
    upsert: (source, signal) =>
      indexPage(instance, source.ownerScope, source.url, source.markdown, signal),
    async search(scope, query, signal) {
      const response = await within(
        instance.search({
          query,
          ai_search_options: {
            retrieval: {
              max_num_results: MAX_RESULTS,
              filters: { owner_scope: scope },
              context_expansion: 0,
            },
          },
        }),
        signal,
        10_000,
      );
      return {
        query: response.search_query,
        results: response.chunks
          .filter((chunk) => chunk.item.metadata?.owner_scope === scope)
          .flatMap((chunk) => {
            try {
              return [
                {
                  url: publicUrl(String(chunk.item.metadata?.source_url)).toString(),
                  text: chunk.text.slice(0, MAX_CHUNK_CHARS),
                  score: chunk.score,
                },
              ];
            } catch {
              return [];
            }
          })
          .slice(0, MAX_RESULTS),
      };
    },
    async deleteOwner(ownerScope) {
      const ids = new Set<string>();
      for (let page = 1; ; page++) {
        const response = await instance.items.list({
          page,
          per_page: MAX_ITEMS_PER_PAGE,
          metadata_filter: JSON.stringify({ owner_scope: ownerScope }),
        });
        for (const item of response.result)
          if (
            item.metadata?.owner_scope === ownerScope &&
            item.key.startsWith(`owners/${ownerScope}/`)
          )
            ids.add(item.id);
        if (response.result.length < MAX_ITEMS_PER_PAGE) break;
      }
      for (const id of ids) await instance.items.delete(id);
    },
  };
}

function createReadTool(
  browser: ResearchBrowser,
  sources: SavedSources | undefined,
  scope: Promise<string>,
  signal: AbortSignal,
  allowedUrls?: Set<string>,
) {
  return createTool({
    id: 'read_web_page',
    description:
      'Read a public web page as rendered Markdown. The retrieved page is queued in this user’s private research index for later source search.',
    inputSchema: z.object({ url: z.string().max(2_048) }),
    execute: async ({ url }) => {
      assertActive(signal);
      const sourceUrl = publicUrl(url).toString();
      if (allowedUrls && !allowedUrls.has(sourceUrl))
        throw new Error(
          'Read only a URL supplied by the user or returned by search. Do not invent URLs or append private data.',
        );
      try {
        const text = await within(browser.readMarkdown(sourceUrl, signal), signal, 20_000);
        const markdown = text.slice(0, MAX_INDEX_CHARS);
        let indexing: { id?: string; status: string; reason?: string } = {
          status: 'unavailable',
        };
        if (sources) {
          try {
            indexing = await within(
              sources.upsert({ ownerScope: await scope, url: sourceUrl, markdown }, signal),
              signal,
              10_000,
            );
          } catch (error) {
            if (signal.aborted) throw error;
            indexing = { status: 'failed', reason: 'indexing_unavailable' };
          }
        }
        return {
          url: sourceUrl,
          markdown: markdown.slice(0, MAX_PAGE_CHARS),
          truncated: text.length > MAX_PAGE_CHARS,
          indexing,
        };
      } catch (error) {
        safeFailure('Reading the page', error);
      }
    },
  });
}

function createSearchTool(
  index: SavedSources,
  scope: Promise<string>,
  signal: AbortSignal,
  allowedUrls?: Set<string>,
) {
  return createTool({
    id: 'search_sources',
    description: 'Search only public pages previously retrieved and indexed for this user.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(MAX_QUERY_CHARS) }),
    execute: async ({ query }) => {
      try {
        const response = await within(index.search(await scope, query, signal), signal, 10_000);
        assertActive(signal);
        return {
          query: response.query,
          results: response.results
            .flatMap((result) => {
              try {
                const url = publicUrl(result.url).toString();
                allowedUrls?.add(url);
                return [{ ...result, url, text: result.text.slice(0, MAX_CHUNK_CHARS) }];
              } catch {
                return [];
              }
            })
            .slice(0, MAX_RESULTS),
        };
      } catch (error) {
        safeFailure('Searching saved sources', error);
      }
    },
  });
}

/** Resolve the same adapter for indexing, retrieval and account deletion. */
export function resolveSavedSources(
  env: ResearchEnv,
  signal: AbortSignal,
): SavedSources | undefined {
  if (env.SAVED_SOURCES) return env.SAVED_SOURCES;
  const restConfigured = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
  if (!env.AI_SEARCH_INSTANCE?.trim() || (!env.AI_SEARCH && !restConfigured)) return undefined;
  const instance = restConfigured
    ? createRestInstance(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!)}/ai-search/namespaces/default/instances/${encodeURIComponent(env.AI_SEARCH_INSTANCE)}`,
        { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN!}` },
        signal,
      )
    : env.AI_SEARCH!.get(env.AI_SEARCH_INSTANCE);
  return createCloudflareSavedSources(instance);
}

export function createResearchTools(
  env: ResearchEnv,
  ownerId: string | undefined,
  signal: AbortSignal,
  allowedUrls?: Set<string>,
): McpTools {
  if (!ownerId?.trim()) return {};
  const restConfigured = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
  let browser = env.RESEARCH_BROWSER;
  const sources = resolveSavedSources(env, signal);
  // Each capability is independently configured. A browser does not require an index.
  if (!browser && (env.BROWSER || restConfigured)) {
    const transport = restConfigured
      ? createRestBrowser(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!)}`,
          env.CLOUDFLARE_API_TOKEN!,
          signal,
        )
      : env.BROWSER!;
    browser = createCloudflareResearchBrowser(transport);
  }
  const scope = researchOwnerScope(ownerId);
  const tools: McpTools = {};
  if (browser) {
    tools.readWebPage = createReadTool(browser, sources, scope, signal, allowedUrls);
    Object.assign(tools, createBrowserActions(browser, signal, allowedUrls));
  }
  if (sources) tools.searchSources = createSearchTool(sources, scope, signal, allowedUrls);

  return tools;
}
