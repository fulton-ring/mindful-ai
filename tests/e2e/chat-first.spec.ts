import { expect, test } from '@playwright/test';

test('chat starts without notes, and creating a note preserves the conversation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  const sidebar = page.getByRole('complementary', { name: 'Conversations', exact: true });
  const initialWidth = (await sidebar.boundingBox())!.width;
  const separator = page.getByRole('separator', { name: 'Resize sidebar' });
  await separator.focus();
  await separator.press('ArrowRight');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await expect(page.getByText('Your private workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
  expect(await (await page.request.get('/api/notes')).json()).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveCount(0);

  const firstMessage = 'Record this thought: A short walk after lunch helps me reset.';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(firstMessage);
  const turn = page.waitForResponse((response) => response.url().endsWith('/api/chat/turns'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await turn;
  expect(response.status()).toBe(200);
  const events = await response.text();
  expect(events).toContain('"type":"done"');
  expect(events).not.toContain('"type":"error"');
  await expect(
    page
      .getByRole('complementary', { name: 'Conversation', exact: true })
      .getByText(firstMessage, { exact: true })
      .first(),
  ).toBeVisible();
  expect(await (await page.request.get('/api/notes')).json()).toEqual([]);

  await page.getByRole('button', { name: 'Record as-is', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Note title' })).toBeVisible();
  await expect(
    page
      .getByRole('complementary', { name: 'Conversation', exact: true })
      .getByText(firstMessage, { exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close conversation', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: /contextual highlights/ })).toHaveCount(0);
  await expect(
    page.getByText('Local demo · authentication and billing are not connected'),
  ).toHaveCount(0);
  await page.locator('.cm-content').fill('I will try a short walk after lunch.');
  await expect
    .poll(async () => {
      const notes = await (await page.request.get('/api/notes')).json();
      return notes[0]?.markdown;
    })
    .toBe('I will try a short walk after lunch.');
  const history = await (await page.request.get('/api/conversations')).json();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveCount(0);
  await page
    .getByRole('button', { name: `Open conversation: ${history[0].title}`, exact: true })
    .click();
  await expect(page.locator('.cm-content')).toContainText('I will try a short walk after lunch.');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Ask one follow-up question.');
  const followup = page.waitForResponse((result) => result.url().endsWith('/api/chat/turns'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect(await (await followup).text()).toContain('"type":"done"');
  await expect(
    page
      .getByRole('complementary', { name: 'Conversation', exact: true })
      .getByText(firstMessage, { exact: true })
      .first(),
  ).toBeVisible();
  const passage = page.locator('.message.assistant .annotated p').first();
  const selectionBottom = await passage.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 0);
    range.setEnd(element.firstChild!, 12);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    return range.getBoundingClientRect().bottom;
  });
  const actions = page.getByRole('toolbar', { name: 'Actions for selected text' });
  await expect(actions).toBeVisible();
  expect(Math.abs((await actions.boundingBox())!.y - selectionBottom)).toBeLessThan(15);
  await page.getByRole('textbox', { name: 'Message', exact: true }).click();
  await expect(actions).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Add persona' }).click();
  await page.getByRole('option', { name: 'Mentor', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Change persona' })).toContainText('Mentor');
  await expect(page.locator('.persona-picker select:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'personas', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Mentor', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit persona' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/walden-chat-first.png', fullPage: true });
  const summaries = await (await page.request.get('/api/conversations')).json();
  expect(summaries).toHaveLength(1);
  await page
    .getByRole('button', { name: `Delete conversation: ${summaries[0].title}`, exact: true })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'Conversation', exact: true })
      .getByText(firstMessage, { exact: true })
      .first(),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/conversations')).json()).toEqual([]);
  expect(await (await page.request.get('/api/notes')).json()).toHaveLength(1);
  await page.request.delete('/api/account');
});

test('accepting a capture creates the first note without losing chat', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/notes')).json()).toEqual([]);
  const message = 'Record this thought: A short walk after lunch helps me reset.';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record as-is', exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/notes')).json()).toEqual([]);
  await page.getByRole('button', { name: 'Record as-is', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(
    'A short walk after lunch helps me reset.',
  );
  await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
  await expect
    .poll(async () => {
      const notes = await (await page.request.get('/api/notes')).json();
      return notes[0]?.provenance[0]?.origin;
    })
    .toBe('agent');
  await page.request.delete('/api/account');
});

test('mobile starts with chat and keeps navigation in a drawer', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Conversations', exact: true }),
  ).not.toBeInViewport();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Record this thought: Take a walk.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Record as-is', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Keep this unsent question');
  await page.getByRole('button', { name: 'Open note', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Note title' })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(composer).toHaveValue('Keep this unsent question');
  await page.screenshot({ path: '/tmp/walden-chat-first-mobile.png', fullPage: true });
  await page.request.delete('/api/account');
});
