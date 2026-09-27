import { expect, test } from '@playwright/test';

test('signed-out visitors see Clerk sign-in and cannot reach application data', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('Sign in to continue.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);

  for (const path of ['/api/notes', '/api/conversations', '/api/personas', '/api/account/export'])
    expect((await page.request.get(path)).status(), path).toBe(401);
  const forged = await page.request.get('/api/notes', {
    headers: { authorization: 'Bearer not-a-clerk-token' },
  });
  expect(forged.status()).toBe(401);

  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByText('Create your account', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Google/ })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('clerk-signup.png'), fullPage: true });
});
