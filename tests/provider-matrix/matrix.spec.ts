import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';
import { startStack } from './stacks.mjs';

type Stack = Awaited<ReturnType<typeof startStack>>;
const test = base.extend<Record<string, never>, { stack: Stack }>({
  stack: [
    async ({}, use, info) => {
      if (info.project.name === 'mixed' && !process.env.WALDEN_TEST_S3_ENDPOINT)
        throw new Error('The mixed project requires WALDEN_TEST_S3_ENDPOINT');
      const stack = await startStack(info.project.name);
      try {
        await use(stack);
      } finally {
        await stack.close();
      }
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  baseURL: async ({ stack }, use) => use(stack.baseURL),
});

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ stack }) => stack.provider.setMode('answer'));
test.afterEach(async ({ stack }, info) => {
  await info.attach('application.log', { body: stack.diagnostics(), contentType: 'text/plain' });
  await info.attach('inference-count.json', {
    body: JSON.stringify({ calls: stack.provider.calls }),
    contentType: 'application/json',
  });
});

async function json(request: APIRequestContext, method: string, path: string, data?: object) {
  const response = await request.fetch(path, { method, data });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function newConversation(request: APIRequestContext) {
  return json(request, 'POST', '/api/conversations', {});
}

async function admit(
  request: APIRequestContext,
  conversation: { id: string; branchId: string },
  message: string,
  attachmentIds?: string[],
) {
  return json(request, 'POST', '/api/chat/turns', {
    requestId: crypto.randomUUID(),
    conversationId: conversation.id,
    branchId: conversation.branchId,
    message,
    noteRevision: null,
    personaId: 'thinking-partner',
    action: 'message',
    attachmentIds,
  });
}

const protocol = { 'X-Walden-Turn-Protocol': '2' };
const message = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const stop = (page: Page) => page.getByRole('button', { name: 'Stop response', exact: true });

async function openApp(page: Page, stack: Stack) {
  const privacy = page.waitForResponse((response) =>
    response.url().includes('/api/account/privacy'),
  );
  await page.goto(stack.baseURL);
  const preference = await (await privacy).json();
  const dialog = page.getByRole('dialog', { name: 'Conversation privacy' });
  if (!preference.acknowledged) {
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Help improve Walden' }).uncheck();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(message(page)).toBeVisible();
}

async function upload(request: APIRequestContext, conversationId: string, bytes: Buffer) {
  const path = `/api/chat/attachments/${conversationId}`;
  const init = await json(request, 'POST', `${path}/initiate`, {
    name: 'matrix.txt',
    mimeType: 'text/plain',
    size: bytes.length,
  });
  if (init.mode === 'presigned') {
    const put = await request.put(init.uploadUrl, { data: bytes, headers: init.headers });
    expect(put.ok(), await put.text()).toBe(true);
    return json(request, 'POST', `${path}/${init.id}/complete`, { name: 'matrix.txt' });
  }
  const response = await request.post(path, {
    multipart: { file: { name: 'matrix.txt', mimeType: 'text/plain', buffer: bytes } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('API notes preserve canonical content, revisions, exports and deletion', async ({
  request,
}) => {
  const note = await json(request, 'POST', '/api/notes', { markdown: 'Original matrix note.' });
  await json(request, 'PATCH', `/api/notes/${note.id}/title`, { title: 'Provider matrix' });
  const saved = await json(request, 'PATCH', `/api/notes/${note.id}`, {
    operationId: crypto.randomUUID(),
    baseRevision: note.revision,
    markdown: 'Edited matrix note — exact bytes.',
    provenance: [],
  });
  expect(saved.revision).toBe(1);
  expect(await json(request, 'GET', `/api/notes/${note.id}`)).toMatchObject({
    title: 'Provider matrix',
    markdown: 'Edited matrix note — exact bytes.',
    revision: 1,
  });
  const exported = await request.get(`/api/notes/${note.id}/export`);
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toBe('Edited matrix note — exact bytes.');
  const removed = await request.delete(`/api/notes/${note.id}`);
  expect(removed.ok()).toBe(true);
  expect((await request.get(`/api/notes/${note.id}`)).status()).toBe(404);
});

test('API uploads real bytes, commits chat, and replays monotonic cursor events', async ({
  request,
  stack,
}) => {
  const conversation = await newConversation(request);
  const bytes = Buffer.from('Attachment matrix: café, λ, and exact bytes.\n');
  const attachment = await upload(request, conversation.id, bytes);
  const download = await request.get(`/api/chat/attachments/${conversation.id}/${attachment.id}`);
  expect(download.ok()).toBe(true);
  expect(await download.body()).toEqual(bytes);
  const before = stack.provider.calls;
  const turn = await admit(request, conversation, 'Read the attached text.', [attachment.id]);
  const events = await request.get(`/api/chat/turns/${turn.turnId}/events`, { headers: protocol });
  expect(events.ok(), await events.text()).toBe(true);
  const text = await events.text();
  expect(text).toContain('Provider matrix answer.');
  expect(text).toContain('[DONE]');
  expect(text).not.toContain('"type":"error"');
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  expect(ids.length).toBeGreaterThan(3);
  expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
  expect(
    (
      await request.get(`/api/chat/turns/${turn.turnId}/events?after=${ids.at(-1)}`, {
        headers: protocol,
      })
    ).status(),
  ).toBe(204);
  const stored = await json(request, 'GET', `/api/conversations/${conversation.id}`);
  expect(stored.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  expect(stored.messages[1].metadata.status).toBe('complete');
  expect(stack.provider.calls).toBe(before + 1);
});

async function waitPartial(stack: Stack, turnId: string) {
  const response = await fetch(`${stack.baseURL}/api/chat/turns/${turnId}/events`, {
    headers: protocol,
    signal: AbortSignal.timeout(20_000),
  });
  expect(response.ok).toBe(true);
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('Partial matrix answer')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Turn ended before partial output: ${text}`);
    text += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
}

test('API Stop persists partial output and replay cannot restart inference', async ({
  request,
  stack,
}) => {
  const conversation = await newConversation(request);
  stack.provider.setMode('hold');
  const before = stack.provider.calls;
  const turn = await admit(request, conversation, 'Hold this response until Stop.');
  await waitPartial(stack, turn.turnId);
  expect(await json(request, 'POST', `/api/chat/turns/${turn.turnId}/cancel`)).toEqual({
    cancelled: true,
  });
  const events = await request.get(`/api/chat/turns/${turn.turnId}/events`, { headers: protocol });
  expect(await events.text()).toContain('Partial matrix answer');
  expect(await events.text()).toContain('[DONE]');
  const stored = await json(request, 'GET', `/api/conversations/${conversation.id}`);
  expect(stored.messages.at(-1).metadata.status).toBe('interrupted');
  expect(stack.provider.calls).toBe(before + 1);
});

test('browser sends an attachment, opens a note, and saves an edit', async ({
  page,
  request,
  stack,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openApp(page, stack);
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'browser-matrix.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Browser uploaded bytes.'),
  });
  await message(page).fill('Record this thought: Matrix browser note.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message.assistant')).toContainText('Provider matrix answer.');
  await expect(stop(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Open note', exact: true }).click();
  const editor = page.locator('[aria-label="Markdown note editor"] .cm-content');
  await expect(editor).toBeVisible();
  await editor.fill('Browser edit saved through the real API.');
  await expect
    .poll(async () =>
      (await json(request, 'GET', '/api/notes')).some(
        (note: { markdown: string }) =>
          note.markdown === 'Browser edit saved through the real API.',
      ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('browser-note.png'), fullPage: true });
});

test('browser reload resumes one admitted turn without duplicating the user or provider call', async ({
  page,
  stack,
}, info) => {
  await openApp(page, stack);
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  stack.provider.setMode('hold');
  const before = stack.provider.calls;
  const prompt = 'Matrix reload recovery must retain this user message.';
  await message(page).fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message.assistant')).toContainText('Partial matrix answer');
  await expect(stop(page)).toBeVisible();
  await page.reload();
  await expect(page.locator('.message.user').filter({ hasText: prompt })).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toContainText('Partial matrix answer');
  await expect(stop(page)).toBeVisible();
  expect(stack.provider.calls).toBe(before + 1);
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
  expect(stack.provider.calls).toBe(before + 1);
  await page.screenshot({ path: info.outputPath('browser-recovery-stop.png'), fullPage: true });
});

test('completed native replay survives a real host restart without another provider request', async ({
  request,
  stack,
}) => {
  const conversation = await newConversation(request);
  const turn = await admit(request, conversation, 'Persist a terminal replay across restart.');
  const path = `/api/chat/turns/${turn.turnId}/events`;
  const original = await request.get(path, { headers: protocol });
  expect(await original.text()).toContain('Provider matrix answer.');
  const calls = stack.provider.calls;
  await stack.restart();
  const replay = await request.get(path, { headers: protocol });
  expect(await replay.text()).toBe(await original.text());
  expect(stack.provider.calls).toBe(calls);
  expect(
    (await json(request, 'GET', `/api/conversations/${conversation.id}`)).messages,
  ).toHaveLength(2);
});
