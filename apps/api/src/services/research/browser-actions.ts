import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { McpTools } from '../mcp';
import {
  assertActive,
  boundedBytes,
  boundedJson,
  escapeRegex,
  publicUrl,
  within,
} from './research-common';

const MAX_LINKS = 80;
const MAX_IMAGE_BYTES = 512_000;

function allowedPage(url: string, allowedUrls: Set<string> | undefined): URL {
  const page = publicUrl(url);
  if (allowedUrls && !allowedUrls.has(page.toString()))
    throw new Error('Read only a URL supplied by the user or returned by search or page links.');
  return page;
}

function browserOptions(page: URL) {
  return {
    url: page.toString(),
    allowRequestPattern: [`^${escapeRegex(page.origin)}(?:/|$)`],
    gotoOptions: { timeout: 15_000, waitUntil: 'domcontentloaded' as const },
  };
}

async function listLinks(
  browser: Pick<BrowserRun, 'quickAction'>,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
  url: string,
) {
  const page = allowedPage(url, allowedUrls);
  assertActive(signal);
  const response = await within(
    browser.quickAction('links', { ...browserOptions(page), visibleLinksOnly: true }),
    signal,
    20_000,
  );
  if (!response.ok) throw new Error('Listing page links failed.');
  const body = await boundedJson<{ success?: boolean; result?: unknown }>(response);
  if (body.success !== true || !Array.isArray(body.result))
    throw new Error('Browser Run returned invalid links.');

  const seen = new Set<string>();
  const links = body.result.flatMap((value) => {
    if (typeof value !== 'string' || value.length > 2_048) return [];
    try {
      const found = publicUrl(value);
      if (found.origin !== page.origin || seen.has(found.toString())) return [];
      seen.add(found.toString());
      return [found.toString()];
    } catch {
      return [];
    }
  });
  const prefix = page.pathname.replace(/\/$/, '');
  links.sort(
    (left, right) =>
      Number(new URL(right).pathname.startsWith(prefix)) -
      Number(new URL(left).pathname.startsWith(prefix)),
  );
  const selected = links.slice(0, MAX_LINKS);
  for (const link of selected) allowedUrls?.add(link);
  return { url: page.toString(), links: selected, truncated: links.length > MAX_LINKS };
}

async function screenshotPage(
  browser: Pick<BrowserRun, 'quickAction'>,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
  url: string,
) {
  const page = allowedPage(url, allowedUrls);
  assertActive(signal);
  const response = await within(
    browser.quickAction('screenshot', {
      ...browserOptions(page),
      viewport: { width: 1280, height: 720 },
      screenshotOptions: { type: 'jpeg', quality: 65 },
    }),
    signal,
    20_000,
  );
  if (!response.ok) throw new Error('Capturing the page failed.');
  const mimeType = response.headers.get('content-type')?.split(';')[0];
  if (mimeType !== 'image/jpeg') throw new Error('Browser Run returned an invalid screenshot.');
  const image = await within(boundedBytes(response, MAX_IMAGE_BYTES), signal, 2_000);
  assertActive(signal);
  return {
    url: page.toString(),
    content: [{ type: 'image', data: Buffer.from(image).toString('base64'), mimeType }],
  };
}

export function createBrowserActions(
  browser: Pick<BrowserRun, 'quickAction'>,
  signal: AbortSignal,
  allowedUrls?: Set<string>,
): McpTools {
  return {
    listWebLinks: createTool({
      id: 'list_web_links',
      description:
        'List visible same-site links from a public page supplied by the user or discovered by research. Returned links can be opened with readWebPage. Use for following relevant pages, not broad crawling.',
      inputSchema: z.object({ url: z.string().max(2_048) }),
      execute: ({ url }) => listLinks(browser, signal, allowedUrls, url),
    }),
    screenshotWebPage: createTool({
      id: 'screenshot_web_page',
      description:
        'See a screenshot of a public page supplied by the user or discovered by research. Use when layout or an image matters and page text is insufficient.',
      inputSchema: z.object({ url: z.string().max(2_048) }),
      execute: ({ url }) => screenshotPage(browser, signal, allowedUrls, url),
    }),
  };
}
