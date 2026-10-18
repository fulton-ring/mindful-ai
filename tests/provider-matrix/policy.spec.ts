import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';
import { startStack } from './stacks.mjs';

type Stack = Awaited<ReturnType<typeof startStack>>;
const test = base.extend<{
  policyEnvironment: Record<string, string | undefined>;
  stack: Stack;
}>({
  policyEnvironment: [{ MESSAGE_LIMIT: undefined }, { option: true }],
  stack: async ({ policyEnvironment }, use, info) => {
    const stack = await startStack(info.project.name, { environment: policyEnvironment });
    try {
      await use(stack);
    } finally {
      await info.attach('application.log', {
        body: stack.diagnostics(),
        contentType: 'text/plain',
      });
      await stack.close();
    }
  },
  baseURL: async ({ stack }, use) => use(stack.baseURL),
});
test.beforeEach(({}, info) => {
  test.skip(
    info.project.name === 'mixed',
    'Account policy parity runs on the native and Cloudflare projects.',
  );
});

async function json(request: APIRequestContext, method: string, path: string, data?: object) {
  const response = await request.fetch(path, { method, data });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function openApp(page: Page, stack: Stack) {
  const privacy = page.waitForResponse((response) =>
    response.url().includes('/api/account/privacy'),
  );
  await page.goto(stack.baseURL);
  const preference = await (await privacy).json();
  if (!preference.acknowledged) {
    const dialog = page.getByRole('dialog', { name: 'Conversation privacy' });
    await dialog.getByRole('checkbox', { name: 'Help improve Walden' }).uncheck();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

async function openAccount(page: Page, planId: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByText('Account plan', { exact: true })).toBeVisible();
  await expect(settings.locator('code').filter({ hasText: planId })).toHaveText(planId);
  return settings;
}

const uploadFile = (name: string, buffer: Buffer) => ({ name, mimeType: 'text/plain', buffer });
async function directUpload(request: APIRequestContext, conversationId: string, bytes: Buffer) {
  const response = await request.post(`/api/chat/attachments/${conversationId}`, {
    multipart: { file: uploadFile('policy.txt', bytes) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function turnRequest(conversation: { id: string; branchId: string }, attachmentIds?: string[]) {
  return {
    requestId: crypto.randomUUID(),
    conversationId: conversation.id,
    branchId: conversation.branchId,
    noteRevision: null,
    personaId: 'thinking-partner',
    action: 'message',
    message: 'Policy admission check.',
    attachmentIds,
  };
}

test('unconfigured default account policy needs no billing setup', async ({
  request,
  page,
  stack,
}) => {
  expect(await json(request, 'GET', '/api/account/policy')).toEqual({
    planId: 'default',
    policy: {
      messages: { limit: 20, windowHours: 4 },
      uploads: { maxBytes: 1_000_000, maxFiles: 5 },
      retention: { idleDays: 7 },
      features: { mcp: true, documentExtraction: true, webResearch: true, webSearch: true },
    },
  });
  expect(await json(request, 'GET', '/api/budget')).toMatchObject({
    used: 0,
    limit: 20,
    windowHours: 4,
  });
  const conversation = await json(request, 'POST', '/api/conversations', {});
  expect(Date.parse(conversation.expiresAt) - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60_000);
  await openApp(page, stack);
  const settings = await openAccount(page, 'default');
  await expect(settings).toContainText(
    'Thread history expires seven days after your last message.',
  );
});

async function assertTinyApi(request: APIRequestContext) {
  expect(await json(request, 'GET', '/api/account/policy')).toEqual({
    planId: 'tiny',
    policy: {
      messages: { limit: 1, windowHours: 1 },
      uploads: { maxBytes: 16, maxFiles: 1 },
      retention: { idleDays: null },
      features: { mcp: false, documentExtraction: false, webResearch: false, webSearch: false },
    },
  });
  // Physical availability stays public; account permissions remain private policy.
  expect((await json(request, 'GET', '/api/config')).capabilities.webSearch).toBe(true);
  const conversation = await json(request, 'POST', '/api/conversations', {});
  expect(conversation.expiresAt).toBeNull();
  const path = `/api/chat/attachments/${conversation.id}`;
  expect(
    (
      await request.post(`${path}/initiate`, {
        data: { name: 'policy.txt', mimeType: 'text/plain', size: 17 },
      })
    ).status(),
  ).toBe(413);
  expect(
    (
      await request.post(path, {
        multipart: { file: uploadFile('policy.txt', Buffer.alloc(17, 'x')) },
      })
    ).status(),
  ).toBe(413);
  const first = await directUpload(request, conversation.id, Buffer.from('one'));
  const second = await directUpload(request, conversation.id, Buffer.from('two'));
  expect(
    (
      await request.post('/api/chat/turns', {
        data: turnRequest(conversation, [first.id, second.id]),
      })
    ).status(),
  ).toBe(400);
  expect((await json(request, 'GET', '/api/budget')).used).toBe(0);
  return conversation;
}

async function sendTinyBrowserTurn(page: Page, stack: Stack) {
  await openApp(page, stack);
  const settings = await openAccount(page, 'tiny');
  await expect(settings).toContainText('Thread history does not expire automatically.');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: 'Chat tools', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Web search', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Web search is disabled for this account.', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  const picker = page.getByLabel('Choose files', { exact: true });
  expect(await picker.getAttribute('accept')).not.toContain('.pdf');
  await picker.setInputFiles([
    uploadFile('one.txt', Buffer.from('one')),
    uploadFile('two.txt', Buffer.from('two')),
  ]);
  await expect(page.getByRole('alert')).toContainText('Choose up to 1 file.');
  await picker.setInputFiles(uploadFile('large.txt', Buffer.alloc(17, 'x')));
  await expect(page.getByRole('alert')).toContainText('Each file must be 16 bytes or smaller.');
  await picker.setInputFiles(uploadFile('tiny.txt', Buffer.from('one')));
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('One permitted turn.');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.locator('.message.assistant')).toContainText('Provider matrix answer.');
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  for (const name of [
    'searchWeb',
    'readWebPage',
    'listWebLinks',
    'screenshotWebPage',
    'searchSources',
    'extractDocument',
  ])
    expect(stack.provider.requestedTools).not.toContain(name);
  return send;
}

test.describe('operator-selected small plan', () => {
  test.use({
    policyEnvironment: {
      MESSAGE_LIMIT: undefined,
      OPENROUTER_API_KEY: 'matrix-availability-only',
      APP_POLICY_JSON: JSON.stringify({ messages: { limit: 2, windowHours: 1 } }),
      APP_PLANS_JSON: JSON.stringify({
        tiny: {
          messages: { limit: 1 },
          uploads: { maxBytes: 16, maxFiles: 1 },
          retention: { idleDays: null },
          features: { mcp: false, documentExtraction: false, webResearch: false, webSearch: false },
        },
      }),
      APP_DEFAULT_PLAN: 'tiny',
    },
  });

  test('enforces tiny quotas, uploads and feature gates in the API and browser', async ({
    request,
    page,
    stack,
  }) => {
    const conversation = await assertTinyApi(request);
    const send = await sendTinyBrowserTurn(page, stack);
    expect(await json(request, 'GET', '/api/budget')).toMatchObject({ used: 1, limit: 1 });
    const calls = stack.provider.calls;
    expect(
      (await request.post('/api/chat/turns', { data: turnRequest(conversation) })).status(),
    ).toBe(429);
    expect(stack.provider.calls).toBe(calls);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await expect(send).toBeDisabled();
  });
});

test.describe('unlimited self-hosted policy', () => {
  test.use({
    policyEnvironment: {
      MESSAGE_LIMIT: undefined,
      APP_POLICY_JSON: JSON.stringify({
        messages: { limit: null },
        uploads: { maxBytes: null, maxFiles: null },
        retention: { idleDays: null },
      }),
    },
  });

  test('accepts six files including over 1 MB and displays unlimited usage without expiry', async ({
    request,
    page,
    stack,
  }) => {
    expect((await json(request, 'GET', '/api/account/policy')).policy).toMatchObject({
      messages: { limit: null },
      uploads: { maxBytes: null, maxFiles: null },
      retention: { idleDays: null },
    });
    expect(await json(request, 'GET', '/api/budget')).toMatchObject({
      limit: null,
      resetsAt: null,
    });
    const conversation = await json(request, 'POST', '/api/conversations', {});
    expect(conversation.expiresAt).toBeNull();
    await openApp(page, stack);
    const large = Buffer.alloc(1_000_001, 'x');
    await page
      .getByLabel('Choose files', { exact: true })
      .setInputFiles([
        uploadFile('large-policy.txt', large),
        ...Array.from({ length: 5 }, (_, index) =>
          uploadFile(`small-${index}.txt`, Buffer.from('small')),
        ),
      ]);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Six files under an unlimited policy.');
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeEnabled();
    const admission = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/chat/turns'),
    );
    await send.click();
    const admitted = await admission;
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const input = admitted.request().postDataJSON();
    expect(input.attachmentIds).toHaveLength(6);
    await expect(page.locator('.message.assistant')).toContainText('Provider matrix answer.');
    await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
    const stored = await json(request, 'GET', `/api/conversations/${input.conversationId}`);
    expect(stored.expiresAt).toBeNull();
    const files = stored.messages[0].parts.filter((part: { type: string }) => part.type === 'file');
    expect(files).toHaveLength(6);
    const big = files.find((part: { filename: string }) => part.filename === 'large-policy.txt');
    const download = await request.get(big.url);
    expect(download.ok()).toBe(true);
    expect(await download.body()).toEqual(large);
    const settings = await openAccount(page, 'default');
    await expect(settings).toContainText('Thread history does not expire automatically.');
    await settings.getByRole('button', { name: 'usage', exact: true }).click();
    await expect(settings.getByText('Unlimited messages', { exact: true })).toBeVisible();
    await expect(settings.getByRole('meter')).toHaveCount(0);
  });
});
