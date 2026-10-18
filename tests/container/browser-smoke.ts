import assert from 'node:assert/strict';
import { readNodeConfig } from '../../apps/api/src/platform/node/config';
import {
  createPlaywrightResearchBrowser,
  type PublicResponse,
} from '../../apps/api/src/platform/node/research/browser';
import { createLocalEmbedder } from '../../apps/api/src/platform/node/research/embeddings';

assert.notEqual(process.getuid?.(), 0, 'Browser checks must run as the image user');
const config = readNodeConfig();
assert.equal(config.chromiumExecutablePath, '/usr/bin/chromium');
const requests: string[] = [];
const browser = createPlaywrightResearchBrowser({
  executablePath: config.chromiumExecutablePath,
  transport: async (url): Promise<PublicResponse> => {
    requests.push(url.href);
    if (url.pathname === '/redirect')
      return { status: 302, headers: { location: '/page' }, body: Buffer.alloc(0) };
    if (url.pathname === '/private')
      return {
        status: 302,
        headers: { location: 'http://localhost/private' },
        body: Buffer.alloc(0),
      };
    return {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(`<!doctype html><html><body>
        <h1>Container browser fixture</h1><p id="result">Waiting</p>
        <script>document.getElementById('result').textContent='Debian Chromium rendered this page'; fetch('http://localhost/private');</script>
        <a href="/next">Visible</a><a href="/hidden" style="display:none">Hidden</a>
        <table><tr><th>Name</th><th>Value</th></tr><tr><td>Browser</td><td>Ready</td></tr></table>
        </body></html>`),
    };
  },
});
const signal = AbortSignal.timeout(60_000);
const markdown = await browser.readMarkdown('https://fixture.example/redirect', signal);
assert.match(markdown, /Debian Chromium rendered this page/);
assert.match(markdown, /\|\s*Name\s*\|\s*Value\s*\|/);
assert.doesNotMatch(markdown, /document.getElementById/);
const links = await browser.listVisibleLinks('https://fixture.example/page', signal);
assert.deepEqual(links, ['https://fixture.example/next']);
const image = await browser.screenshot('https://fixture.example/page', signal);
assert.equal(image.mimeType, 'image/jpeg');
assert.equal(image.bytes[0], 255);
assert.ok(image.bytes.length > 100 && image.bytes.length <= 512_000);
await assert.rejects(browser.readMarkdown('https://fixture.example/private', signal));
assert.ok(requests.every((url) => url.startsWith('https://fixture.example/')));
const embedder = createLocalEmbedder({
  modelDirectory: config.embeddingModelDir,
  revision: config.embeddingRevision,
});
const vectors = await embedder.embed(['Walden pond', 'Debian Chromium'], signal);
assert.equal(vectors.length, 2);
assert.notDeepEqual(vectors[0], vectors[1]);
console.log(
  'Non-root sandboxed Chromium: rendered Markdown, links, screenshot and private redirect checks passed; offline native CPU embeddings passed.',
);
