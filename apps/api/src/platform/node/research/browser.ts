import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { type BrowserContext, chromium, type Route } from 'playwright';
import type { ResearchBrowser } from '../../../services/research/ports';
import { publicUrl, within } from '../../../services/research/research-common';
import { htmlToMarkdown } from '../documents/convert';

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export async function resolvePublicLookup(hostname: string): Promise<LookupFunction> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new Error('Research destination resolved to a non-public address.');
  const target = addresses[0]!;
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [target]);
    else callback(null, target.address, target.family);
  };
}

export type PublicResponse = { status: number; headers: Record<string, string>; body: Buffer };
/** DNS is resolved and validated for every request; the socket uses that exact IP. */
export async function fetchPublicResource(url: URL, signal: AbortSignal): Promise<PublicResponse> {
  publicUrl(url.toString());
  signal.throwIfAborted();
  const pinnedLookup = await resolvePublicLookup(url.hostname);
  return await new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        signal,
        timeout: 15_000,
        headers: {
          'user-agent': 'WaldenResearch/1.0',
          accept:
            'text/html,application/xhtml+xml,image/*,text/css,application/javascript,*/*;q=0.8',
          'accept-encoding': 'identity',
        },
        lookup: pinnedLookup,
      },
      (response) => {
        if (
          response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity'
        ) {
          request.destroy(new Error('Encoded research resources are not supported.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8_000_000) {
            request.destroy(new Error('Research resource exceeds size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (
              value !== undefined &&
              !['transfer-encoding', 'connection', 'content-length', 'set-cookie'].includes(key)
            )
              headers[key] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('Research resource timed out.')));
    request.on('error', reject);
    request.end();
  });
}

type BrowserOptions = {
  executablePath?: string;
  /** Dependency injection for deterministic offline rendered-page fixtures. */
  transport?: (url: URL, signal: AbortSignal) => Promise<PublicResponse>;
};

async function followRedirects(
  initial: URL,
  origin: string,
  signal: AbortSignal,
  transport: NonNullable<BrowserOptions['transport']>,
): Promise<PublicResponse> {
  let target = initial;
  for (let hop = 0; hop < 6; hop++) {
    if (target.origin !== origin) throw new Error('Cross-origin research redirect rejected.');
    const response = await transport(target, signal);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      target = publicUrl(new URL(response.headers.location, target).toString());
      continue;
    }
    if (target.href !== initial.href && response.headers['content-type']?.includes('text/html')) {
      const href = target.href
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      // Playwright only intercepts the first URL of a browser redirect chain.
      // Fulfill the final document directly; its relative assets/links use the final URL.
      const base = `<base href="${href}">`;
      const html = new TextDecoder().decode(response.body);
      const body = Buffer.from(
        /<head(?:\s[^>]*)?>/i.test(html)
          ? html.replace(/<head(?:\s[^>]*)?>/i, (match) => match + base)
          : base + html,
      );
      return { ...response, body };
    }
    return response;
  }
  throw new Error('Research redirect limit reached.');
}

function resourceHandler(
  origin: string,
  signal: AbortSignal,
  transport: NonNullable<BrowserOptions['transport']>,
) {
  let requests = 0;
  let active = 0;
  let bytes = 0;
  return async (route: Route) => {
    try {
      const request = route.request();
      const target = publicUrl(request.url());
      if (target.origin !== origin || request.method() !== 'GET' || ++requests > 100 || active >= 8)
        return await route.abort('blockedbyclient');
      active++;
      let response: PublicResponse;
      try {
        response = await followRedirects(
          target,
          origin,
          signal,
          async (destination, requestSignal) => {
            if (++requests > 100) throw new Error('Research request limit reached.');
            const resource = await transport(destination, requestSignal);
            bytes += resource.body.byteLength;
            if (bytes > 16_000_000) throw new Error('Research page exceeds total resource limit.');
            return resource;
          },
        );
      } finally {
        active--;
      }
      await route.fulfill(response);
    } catch {
      await route.abort('blockedbyclient').catch(() => {});
    }
  };
}

/** Each operation owns an isolated browser context and cancels every pending socket. */
async function operation<T>(
  options: BrowserOptions,
  url: string,
  signal: AbortSignal,
  read: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const pageUrl = publicUrl(url);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(20_000)]);
  signal.throwIfAborted();
  const launching = chromium.launch({
    headless: true,
    chromiumSandbox: true,
    timeout: 15_000,
    executablePath: options.executablePath,
    args: [
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // Unhandled browser networking fails closed; approved responses come from the pinned Node transport.
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  let browser: Awaited<typeof launching>;
  try {
    browser = await within(launching, combined, 15_000);
  } catch (error) {
    void launching.then((opened) => opened.close()).catch(() => {});
    throw error;
  }
  let context: BrowserContext | undefined;
  const abort = () => {
    void browser.close().catch(() => {});
  };
  combined.addEventListener('abort', abort, { once: true });
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route(
      '**/*',
      resourceHandler(pageUrl.origin, combined, options.transport ?? fetchPublicResource),
    );
    return await within(read(context), combined, 20_000);
  } finally {
    controller.abort();
    combined.removeEventListener('abort', abort);
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
async function visit<T>(
  options: BrowserOptions,
  url: string,
  signal: AbortSignal,
  read: (page: import('playwright').Page) => Promise<T>,
): Promise<T> {
  return operation(options, url, signal, async (context) => {
    const page = await context.newPage();
    page.on('popup', (popup) => {
      void popup.close().catch(() => {});
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (!response?.ok()) throw new Error('Research page could not be retrieved.');
    // Give synchronous scripts and one animation frame time to render, without unbounded networkidle.
    await page.evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    return read(page);
  });
}
export function createPlaywrightResearchBrowser(options: BrowserOptions = {}): ResearchBrowser {
  return {
    readMarkdown: (url, signal) =>
      visit(options, url, signal, async (page) => {
        const html = await page.evaluate<string>(`(() => {
        const copy=document.body.cloneNode(true);
        copy.querySelectorAll('script,style,noscript,template').forEach(node=>node.remove());
        return copy.innerHTML;
      })()`);
        if (html.length > 2_000_000) throw new Error('Rendered page exceeds size limit.');
        return htmlToMarkdown(html).slice(0, 256_000);
      }),
    listVisibleLinks: (url, signal) =>
      visit(options, url, signal, (page) =>
        page.evaluate<string[]>(
          `Array.from(document.querySelectorAll('a[href]')).filter(element=>{const box=element.getBoundingClientRect();const style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none';}).map(element=>element.href).slice(0,2000)`,
        ),
      ),
    screenshot: (url, signal) =>
      visit(options, url, signal, async (page) => {
        const bytes = await page.screenshot({
          type: 'jpeg',
          quality: 65,
          fullPage: false,
          timeout: 5000,
        });
        if (bytes.length > 512_000) throw new Error('Research screenshot exceeds size limit.');
        return { bytes, mimeType: 'image/jpeg' };
      }),
  };
}
