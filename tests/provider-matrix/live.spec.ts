import { expect, test } from '@playwright/test';
import { startStack } from './stacks.mjs';

const cases = [
  {
    provider: 'cloudflare',
    stack: 'cloudflare',
    configured: process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN,
    inference: {
      AI_PROVIDER: 'cloudflare',
      AI_MODEL: '@cf/zai-org/glm-5.3-flash',
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    },
  },
  {
    provider: 'openrouter',
    stack: 'node',
    configured: process.env.OPENROUTER_API_KEY,
    inference: {
      AI_PROVIDER: 'openrouter',
      AI_MODEL: 'google/gemma-4-26b-a4b-it',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    },
  },
];

for (const entry of cases)
  test(`${entry.stack} browser chat uses live ${entry.provider} inference and persists across reload`, async ({
    page,
  }) => {
    test.skip(
      !entry.configured,
      'Requires explicit test credentials; never runs in the deterministic matrix.',
    );
    const stack = await startStack(entry.stack, { inference: entry.inference });
    try {
      const config = await (await page.request.get(`${stack.baseURL}/api/config`)).json();
      expect(config.inference.provider).toBe(entry.provider);
      await page.goto(stack.baseURL);
      const privacy = page.getByRole('dialog', { name: 'Conversation privacy' });
      await expect(privacy).toBeVisible();
      await privacy.getByRole('checkbox', { name: 'Help improve Walden' }).uncheck();
      await privacy.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(privacy).toBeHidden();
      const message = page.getByRole('textbox', { name: 'Message', exact: true });
      await expect(message).toBeVisible();
      const marker = `${entry.provider} matrix connected`;
      const prompt = `Reply with exactly: ${marker}`;
      await message.fill(prompt);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const assistant = page.locator('.message.assistant');
      await expect(assistant).toContainText(new RegExp(marker, 'i'));
      await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
      const conversationURL = page.url();
      expect(new URL(conversationURL).pathname).toMatch(/^\/conversations\//);
      await page.reload();
      await expect(page.locator('.message.user').filter({ hasText: prompt })).toHaveCount(1);
      await expect(assistant).toHaveCount(1);
      await expect(assistant).toContainText(new RegExp(marker, 'i'));
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      await stack.close();
    }
  });
