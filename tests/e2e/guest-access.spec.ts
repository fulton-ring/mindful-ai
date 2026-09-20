import { expect, test } from '@playwright/test';

test('public visitors have isolated workspaces and optional Clerk controls', async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const page = await first.newPage();
    await page.goto(baseURL ?? 'http://localhost:8787');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    const title = `Private guest ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Note title' }).fill(title);
    await page.locator('.cm-content').fill('Only this guest browser owns this note.');
    await expect
      .poll(async () => {
        const response = await first.request.get(`${baseURL}/api/notes`);
        return (await response.json()).find((note: { title: string }) => note.title === title)
          ?.markdown;
      })
      .toBe('Only this guest browser owns this note.');
    const notes = await (await first.request.get(`${baseURL}/api/notes`)).json();
    const note = notes.find((value: { title: string }) => value.title === title);
    const other = await second.newPage();
    await other.goto(baseURL ?? 'http://localhost:8787');
    await expect(other.getByRole('button', { name: 'New note', exact: true })).toBeVisible();
    expect((await second.request.get(`${baseURL}/api/notes/${note.id}`)).status()).toBe(404);
    expect((await first.request.post(`${baseURL}/api/billing/checkout`)).status()).toBe(404);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await expect(page.getByText('Create your account', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Google/ })).toBeVisible();
    await expect(page.getByLabel(/password/i)).toHaveCount(0);
    await page.screenshot({ path: '/tmp/walden-clerk-signup.png', fullPage: true });
    await first.request.delete(`${baseURL}/api/notes/${note.id}`);
  } finally {
    await first.request.delete(`${baseURL}/api/account`);
    await second.request.delete(`${baseURL}/api/account`);
    await first.close();
    await second.close();
  }
});
