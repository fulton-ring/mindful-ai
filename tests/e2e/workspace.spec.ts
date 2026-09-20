import { expect, test } from '@playwright/test';

test('note autosave survives reload and chat leaves the note intact', async ({ page }) => {
  page.on('pageerror', (error) => console.error(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  const title = `Smoke ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Note title' }).fill(title);
  await page.locator('.cm-content').fill('My own starting thought.');
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/notes');
      const notes = await response.json();
      return notes.find((note: { title: string }) => note.title === title)?.markdown;
    })
    .toBe('My own starting thought.');
  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.locator('.cm-content')).toContainText('My own starting thought.');
  await page.getByRole('button', { name: 'Open conversation', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Help me consider this thought.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.cm-content')).toContainText('My own starting thought.');
  await page.screenshot({ path: '/tmp/walden-workspace.png', fullPage: true });
});
