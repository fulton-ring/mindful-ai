import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { McpTools } from '../mcp';
import type { ResearchBrowser } from './ports';
import { createCloudflareResearchBrowser } from './research';
import { assertActive, publicUrl, within } from './research-common';

const MAX_LINKS = 80;
const MAX_IMAGE_BYTES = 512_000;

function allowedPage(url: string, allowedUrls: Set<string> | undefined): URL {
  const page = publicUrl(url);
  if (allowedUrls && !allowedUrls.has(page.toString()))
    throw new Error('Read only a URL supplied by the user or returned by search or page links.');
  return page;
}

async function listLinks(
  browser: ResearchBrowser,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
  url: string,
) {
  const page = allowedPage(url, allowedUrls);
  assertActive(signal);
  const values = await within(browser.listVisibleLinks(page.toString(), signal), signal, 20_000);
  const seen = new Set<string>();
  const links = values.flatMap((value) => {
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
  browser: ResearchBrowser,
  signal: AbortSignal,
  allowedUrls: Set<string> | undefined,
  url: string,
) {
  const page = allowedPage(url, allowedUrls);
  assertActive(signal);
  const { bytes: image, mimeType } = await within(
    browser.screenshot(page.toString(), signal),
    signal,
    20_000,
  );
  if (mimeType !== 'image/jpeg' || image.byteLength > MAX_IMAGE_BYTES)
    throw new Error('Invalid screenshot.');
  assertActive(signal);
  return {
    url: page.toString(),
    content: [{ type: 'image', data: Buffer.from(image).toString('base64'), mimeType }],
  };
}

export function createBrowserActions(
  transport: ResearchBrowser | Pick<BrowserRun, 'quickAction'>,
  signal: AbortSignal,
  allowedUrls?: Set<string>,
): McpTools {
  const browser =
    'quickAction' in transport ? createCloudflareResearchBrowser(transport) : transport;
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
