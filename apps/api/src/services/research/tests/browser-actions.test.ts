import { expect, it, vi } from 'vitest';
import { createBrowserActions } from '../browser-actions';

type ExecutableTool = { execute: (input: { url: string }) => Promise<unknown> };

it('discovers same-origin links while rejecting private and unlisted URLs', async () => {
  const quickAction = vi.fn().mockResolvedValueOnce(
    Response.json({
      success: true,
      result: [
        'https://github.com/fusedio/udfs/tree/main/public',
        'https://github.com/fusedio/udfs/tree/main/public',
        'https://github.com/other/repo',
        'http://127.0.0.1/private',
      ],
    }),
  );
  const allowedUrls = new Set(['https://github.com/fusedio/udfs']);
  const tools = createBrowserActions(
    { quickAction } as never,
    new AbortController().signal,
    allowedUrls,
  );
  const links = tools.listWebLinks as unknown as ExecutableTool;

  expect(await links.execute({ url: 'https://github.com/fusedio/udfs' })).toEqual({
    url: 'https://github.com/fusedio/udfs',
    links: ['https://github.com/fusedio/udfs/tree/main/public', 'https://github.com/other/repo'],
    truncated: false,
  });
  expect(allowedUrls).toContain('https://github.com/fusedio/udfs/tree/main/public');
  expect(allowedUrls).not.toContain('http://127.0.0.1/private');
  await expect(links.execute({ url: 'https://github.com/unlisted' })).rejects.toThrow(
    'supplied by the user',
  );
  expect(quickAction).toHaveBeenCalledTimes(1);
});

it('returns screenshot bytes as model-visible image content', async () => {
  const quickAction = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  );
  const tools = createBrowserActions(
    { quickAction } as never,
    new AbortController().signal,
    new Set(['https://example.com/']),
  );
  const screenshot = tools.screenshotWebPage as unknown as ExecutableTool;

  expect(await screenshot.execute({ url: 'https://example.com/' })).toEqual({
    url: 'https://example.com/',
    content: [{ type: 'image', data: '/9j/', mimeType: 'image/jpeg' }],
  });
  expect(quickAction).toHaveBeenCalledWith(
    'screenshot',
    expect.objectContaining({ url: 'https://example.com/' }),
  );
});
