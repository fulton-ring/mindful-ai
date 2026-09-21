import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { McpTools } from './mcp';

const MAX_PAGE_CHARS = 12_000;
const MAX_INDEX_CHARS = 64_000;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_QUERY_CHARS = 500;
const MAX_RESULTS = 5;
const MAX_CHUNK_CHARS = 4_000;

export type ResearchEnv = {
  BROWSER?: BrowserRun;
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
};

function abortError(): DOMException {
  return new DOMException('Research request was cancelled.', 'AbortError');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function publicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid public HTTP or HTTPS URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only public HTTP and HTTPS URLs are supported.');
  }
  if (url.username || url.password)
    throw new Error('URLs containing credentials are not supported.');

  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const privateName =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal');
  const ipLiteral = hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (!hostname || !hostname.includes('.') || privateName || ipLiteral) {
    throw new Error('Only public internet URLs are supported.');
  }
  url.hash = '';
  return url;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function within<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  assertActive(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new Error('Research request timed out.')), timeoutMs);
  });
  try {
    return await Promise.race([promise, stop]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function boundedJson<T = { success?: boolean; result?: unknown }>(
  response: Response,
): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Browser Run returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Browser Run response was too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

class ResearchApiError extends Error {
  constructor(readonly status: number) {
    super('Cloudflare API request failed.');
  }
}

type ResearchInstance = {
  items: {
    upload: (
      name: string,
      content: string,
      options: { metadata: Record<string, unknown> },
    ) => Promise<AiSearchItemInfo>;
  };
  search: (request: AiSearchSearchRequest) => Promise<AiSearchSearchResponse>;
};

type ResearchBrowser = {
  quickAction: (action: 'markdown', options: BrowserRunMarkdownOptions) => Promise<Response>;
};

async function cloudflareResult<T>(response: Response): Promise<T> {
  const envelope = await boundedJson(response);
  if (!response.ok || envelope.success !== true || envelope.result === undefined) {
    throw new ResearchApiError(response.status);
  }
  return envelope.result as T;
}

async function shortHash(value: string): Promise<string> {
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
): ResearchBrowser {
  return {
    quickAction: (_action, options) =>
      fetch(`${apiBase}/browser-rendering/markdown`, {
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

function createResearchTransport(
  env: ResearchEnv,
  signal: AbortSignal,
): { instance: ResearchInstance; browser: ResearchBrowser } {
  const restConfigured = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
  if (restConfigured) {
    const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!)}`;
    const apiHeaders = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN!}` };
    const searchBase = `${apiBase}/ai-search/namespaces/default/instances/${encodeURIComponent(env.AI_SEARCH_INSTANCE!)}`;
    return {
      instance: createRestInstance(searchBase, apiHeaders, signal),
      browser: createRestBrowser(apiBase, env.CLOUDFLARE_API_TOKEN!, signal),
    };
  }
  return {
    instance: env.AI_SEARCH!.get(env.AI_SEARCH_INSTANCE!),
    browser: env.BROWSER!,
  };
}

async function indexPage(
  instance: ResearchInstance,
  scope: string,
  sourceUrl: string,
  markdown: string,
  signal: AbortSignal,
): Promise<{ id?: string; status: string; reason?: string }> {
  const key = `owners/${scope}/${await shortHash(sourceUrl)}.md`;
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

async function readPage(
  browser: ResearchBrowser,
  instance: ResearchInstance,
  ownerScope: Promise<string>,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
  url: string,
) {
  assertActive(signal);
  const sourceUrl = publicUrl(url).toString();
  if (allowedUrls && !allowedUrls.has(sourceUrl))
    throw new Error(
      'Read only a URL supplied by the user or returned by search. Do not invent URLs or append private data.',
    );
  try {
    const originPattern = `^${escapeRegex(new URL(sourceUrl).origin)}(?:/|$)`;
    const response = await within(
      browser.quickAction('markdown', {
        url: sourceUrl,
        allowRequestPattern: [originPattern],
        gotoOptions: { timeout: 15_000, waitUntil: 'domcontentloaded' },
      }),
      signal,
      20_000,
    );
    assertActive(signal);
    if (!response.ok) throw new Error('Browser Run rejected the page.');
    const body = await within(boundedJson(response), signal, 2_000);
    if (body.success !== true || typeof body.result !== 'string')
      throw new Error('Browser Run returned an invalid response.');
    const indexedMarkdown = body.result.slice(0, MAX_INDEX_CHARS);
    const markdown = indexedMarkdown.slice(0, MAX_PAGE_CHARS);
    const scope = await ownerScope;
    assertActive(signal);
    const indexing = await indexPage(instance, scope, sourceUrl, indexedMarkdown, signal);
    return {
      url: sourceUrl,
      markdown,
      truncated: body.result.length > MAX_PAGE_CHARS,
      indexing,
    };
  } catch (error) {
    safeFailure('Reading the page', error);
  }
}

function createReadWebPageTool(
  browser: ResearchBrowser,
  instance: ResearchInstance,
  ownerScope: Promise<string>,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
) {
  return createTool({
    id: 'read_web_page',
    description:
      'Read a public web page as rendered Markdown. The retrieved page is queued in this user’s private research index for later source search.',
    inputSchema: z.object({ url: z.string().max(2_048) }),
    execute: ({ url }) => readPage(browser, instance, ownerScope, signal, allowedUrls, url),
  });
}

async function searchSavedSources(
  instance: ResearchInstance,
  ownerScope: Promise<string>,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
  query: string,
) {
  assertActive(signal);
  try {
    const scope = await ownerScope;
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
    assertActive(signal);
    return {
      query: response.search_query,
      results: response.chunks
        .filter((chunk) => chunk.item.metadata?.owner_scope === scope)
        .flatMap((chunk) => {
          try {
            const url = publicUrl(String(chunk.item.metadata?.source_url)).toString();
            allowedUrls?.add(url);
            return [{ text: chunk.text.slice(0, MAX_CHUNK_CHARS), score: chunk.score, url }];
          } catch {
            return [];
          }
        })
        .slice(0, MAX_RESULTS),
    };
  } catch (error) {
    safeFailure('Searching saved sources', error);
  }
}

function createSearchSourcesTool(
  instance: ResearchInstance,
  ownerScope: Promise<string>,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
) {
  return createTool({
    id: 'search_sources',
    description: 'Search only public pages previously retrieved and indexed for this user.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(MAX_QUERY_CHARS) }),
    execute: ({ query }) => searchSavedSources(instance, ownerScope, signal, allowedUrls, query),
  });
}

export function createResearchTools(
  env: ResearchEnv,
  ownerId: string | undefined,
  signal: AbortSignal,
  allowedUrls?: Set<string>,
): McpTools {
  const restConfigured = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
  if (
    !ownerId?.trim() ||
    !env.AI_SEARCH_INSTANCE?.trim() ||
    (!env.BROWSER && !restConfigured) ||
    (!env.AI_SEARCH && !restConfigured)
  )
    return {};
  const { instance, browser } = createResearchTransport(env, signal);
  const ownerScope = shortHash(ownerId);
  return {
    readWebPage: createReadWebPageTool(browser, instance, ownerScope, signal, allowedUrls),
    searchSources: createSearchSourcesTool(instance, ownerScope, signal, allowedUrls),
  };
}
