import { expect, type Page } from '@playwright/test';
import { type Api, message, noteEditor, sendMessage, signedIn as test } from './support';

const firstMessage = 'Record this thought: A short walk after lunch helps me reset.';

type Summary = { id: string; title: string; noteId?: string | null };

const thread = (page: Page) => page.getByRole('complementary', { name: 'Thread', exact: true });

async function cleanUp(api: Api, before: { conversations: Set<string>; notes: Set<string> }) {
  for (const { id } of await api.get<Summary[]>('/api/conversations'))
    if (!before.conversations.has(id)) await api.send('DELETE', `/api/conversations/${id}`);
  for (const { id } of await api.get<{ id: string }[]>('/api/notes'))
    if (!before.notes.has(id)) await api.send('DELETE', `/api/notes/${id}`);
}

async function snapshot(api: Api) {
  return {
    conversations: new Set((await api.get<Summary[]>('/api/conversations')).map(({ id }) => id)),
    notes: new Set((await api.get<{ id: string }[]>('/api/notes')).map(({ id }) => id)),
  };
}

test('a chat starts without a note, and recording a thought keeps the conversation', async ({
  page,
  api,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const before = await snapshot(api);
  try {
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    const sidebar = page.getByRole('complementary', { name: 'Threads', exact: true });
    const initialWidth = (await sidebar.boundingBox())!.width;
    const separator = page.getByRole('separator', { name: 'Resize sidebar' });
    await separator.focus();
    await separator.press('ArrowRight');
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBeGreaterThan(initialWidth);
    await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveCount(0);

    await sendMessage(page, firstMessage);
    await expect(thread(page).getByText(firstMessage, { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Record as-is', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Note title' })).toBeVisible();
    await expect(noteEditor(page)).toContainText('A short walk after lunch helps me reset.');
    await expect(thread(page).getByText(firstMessage, { exact: true }).first()).toBeVisible();

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
    await message(page).click();
    await expect(actions).toHaveCount(0);

    await page.getByRole('combobox', { name: 'Change persona' }).click();
    await page.getByRole('option', { name: 'Mentor' }).click();
    await expect(page.getByRole('combobox', { name: 'Change persona' })).toContainText('Mentor');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'personas', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Mentor', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit persona' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();

    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('chat-first.png'), fullPage: true });
  } finally {
    await cleanUp(api, before);
  }
});

test('mobile starts with chat and keeps navigation in a drawer', async ({
  page,
  api,
}, testInfo) => {
  const before = await snapshot(api);
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(message(page)).toBeVisible();
    await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    await expect(
      page.getByRole('complementary', { name: 'Threads', exact: true }),
    ).not.toBeInViewport();

    await sendMessage(page, 'Record this thought: Take a walk.');
    await page.getByRole('button', { name: 'Record as-is', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Note title' })).toBeVisible();
    await page.getByRole('button', { name: 'Close note', exact: true }).first().click();
    await message(page).fill('Keep this unsent question');
    await page.getByRole('button', { name: 'Open note', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Note title' })).toBeVisible();
    await page.getByRole('button', { name: 'Close note', exact: true }).first().click();
    await expect(message(page)).toHaveText('Keep this unsent question');
    await page.screenshot({ path: testInfo.outputPath('chat-first-mobile.png'), fullPage: true });
  } finally {
    await cleanUp(api, before);
  }
});
