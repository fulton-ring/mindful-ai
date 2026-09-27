import { expect } from '@playwright/test';
import { message, noteEditor, sendMessage, signedIn as test } from './support';

test('note autosave survives reload and chat leaves the note intact', async ({
  page,
  api,
}, testInfo) => {
  page.on('pageerror', (error) => console.error(error.message));
  const created = (await (await api.send('POST', '/api/notes', {})).json()) as { id: string };
  const title = `Smoke ${Date.now()}`;
  await api.send('PATCH', `/api/notes/${created.id}/title`, { title });
  try {
    await page.reload();
    await page.getByRole('button', { name: `Open note: ${title}`, exact: true }).click();
    await noteEditor(page).fill('My own starting thought.');
    await expect
      .poll(async () => (await api.get<{ markdown: string }>(`/api/notes/${created.id}`)).markdown)
      .toBe('My own starting thought.');
    await page.reload();
    await page.getByRole('button', { name: `Open note: ${title}`, exact: true }).click();
    await expect(noteEditor(page)).toContainText('My own starting thought.');
    await expect(message(page)).toBeVisible();
    await sendMessage(page, 'Help me consider this thought.');
    await expect(noteEditor(page)).toContainText('My own starting thought.');
    await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  } finally {
    await api.send('DELETE', `/api/notes/${created.id}`);
  }
});
