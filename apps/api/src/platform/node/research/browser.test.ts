import { lookup } from 'node:dns/promises';
import { expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]),
}));

import {
  createPlaywrightResearchBrowser,
  fetchPublicResource,
  isPublicAddress,
  type PublicResponse,
  resolvePublicLookup,
} from './browser';

it.each([
  '127.0.0.1',
  '10.1.2.3',
  '169.254.169.254',
  '100.64.0.1',
  '192.168.1.1',
  '::1',
  'fc00::1',
  'fe80::1',
  '::ffff:127.0.0.1',
  '224.0.0.1',
  '0.0.0.0',
  '2001:db8::1',
])('rejects private/reserved socket address %s', (address) => {
  expect(isPublicAddress(address)).toBe(false);
});
it('rejects private DNS destinations before creating an outbound socket', async () => {
  await expect(
    fetchPublicResource(new URL('http://localtest.me/'), new AbortController().signal),
  ).rejects.toThrow(/non-public/);
});
const browserTest = process.env.WALDEN_TEST_BROWSER === '1' ? it : it.skip;

browserTest(
  'renders scripts, converts tables to Markdown, lists visible links, and screenshots an offline web fixture',
  async () => {
    const requests: string[] = [];
    const browser = createPlaywrightResearchBrowser({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      transport: async (url): Promise<PublicResponse> => {
        requests.push(url.toString());
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from(
            `<!doctype html><html><body><h1>Rendered fixture</h1><p id="result">Waiting</p><script>document.getElementById('result').textContent='A puppy plays in the park'; fetch('http://localhost/private');</script><a href="/next">Visible</a><a href="/hidden" style="display:none">Hidden</a><table><tr><th>Name</th><th>Value</th></tr><tr><td>Dog</td><td>Happy</td></tr></table></body></html>`,
          ),
        };
      },
    });
    const signal = new AbortController().signal;
    const markdown = await browser.readMarkdown('https://fixture.example/', signal);
    expect(markdown).toContain('A puppy plays in the park');
    expect(markdown).toMatch(/\|\s*Name\s*\|\s*Value\s*\|/);
    expect(markdown).not.toContain('document.getElementById');
    const links = await browser.listVisibleLinks('https://fixture.example/', signal);
    expect(links).toContain('https://fixture.example/next');
    expect(links).not.toContain('https://fixture.example/hidden');
    const image = await browser.screenshot('https://fixture.example/', signal);
    expect(image.mimeType).toBe('image/jpeg');
    expect(image.bytes[0]).toBe(255);
    expect(image.bytes.length).toBeLessThanOrEqual(512000);
    expect(requests.every((url) => url.startsWith('https://fixture.example/'))).toBe(true);
  },
  30_000,
);

it('pins the validated DNS answer for both Node socket lookup modes', async () => {
  vi.mocked(
    lookup as (
      hostname: string,
      options: { all: true },
    ) => Promise<Array<{ address: string; family: number }>>,
  ).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
  const pinned = await resolvePublicLookup('example.com');
  const one = vi.fn();
  pinned('example.com', { all: false }, one);
  expect(one).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  const all = vi.fn();
  pinned('example.com', { all: true }, all);
  expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
});
it('rejects a DNS answer containing even one private address', async () => {
  vi.mocked(
    lookup as (
      hostname: string,
      options: { all: true },
    ) => Promise<Array<{ address: string; family: number }>>,
  ).mockResolvedValueOnce([
    { address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]);
  await expect(resolvePublicLookup('example.com')).rejects.toThrow('non-public');
});

browserTest(
  'follows same-origin redirects and rejects private or cross-origin redirect destinations',
  async () => {
    const requests: string[] = [];
    const browser = createPlaywrightResearchBrowser({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      transport: async (url): Promise<PublicResponse> => {
        requests.push(url.toString());
        if (url.pathname === '/allowed')
          return { status: 302, headers: { location: '/final' }, body: Buffer.alloc(0) };
        if (url.pathname === '/blocked')
          return {
            status: 302,
            headers: { location: 'http://localhost/private' },
            body: Buffer.alloc(0),
          };
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from('<html><body><h1>Final rendered page</h1></body></html>'),
        };
      },
    });
    const signal = new AbortController().signal;
    expect(await browser.readMarkdown('https://fixture.example/allowed', signal)).toContain(
      'Final rendered page',
    );
    await expect(browser.readMarkdown('https://fixture.example/blocked', signal)).rejects.toThrow();
    expect(requests).toEqual([
      'https://fixture.example/allowed',
      'https://fixture.example/final',
      'https://fixture.example/blocked',
    ]);
  },
  30_000,
);

browserTest(
  'cancels a pending rendered-page operation and closes its browser context',
  async () => {
    const controller = new AbortController();
    const browser = createPlaywrightResearchBrowser({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      transport: async (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
          controller.abort();
        }),
    });
    await expect(
      browser.readMarkdown('https://fixture.example/', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  },
  30_000,
);
