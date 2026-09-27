import { test as base, expect, type Page } from '@playwright/test';

/**
 * Every /api route except /api/config requires a Clerk bearer token, so signed-in
 * specs need a saved browser session. Sign in once against the test Worker and save
 * it, e.g. `pnpm exec playwright codegen --save-storage=.auth/e2e.json http://localhost:8788`,
 * then run with `E2E_STORAGE_STATE=.auth/e2e.json`. Without it these specs are skipped.
 * They also need model inference configured for the test Worker.
 */
const storageState = process.env.E2E_STORAGE_STATE;

export const signedIn = base.extend<{ api: Api }>({
  storageState: storageState ?? { cookies: [], origins: [] },
  api: async ({ page }, use) => {
    await use(new Api(page));
  },
});
signedIn.skip(!storageState, 'Set E2E_STORAGE_STATE to a signed-in Clerk session.');
signedIn.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(message(page)).toBeVisible();
});

export class Api {
  constructor(private readonly page: Page) {}

  private async headers() {
    const token = await this.page.evaluate(
      () =>
        (
          window as unknown as {
            Clerk?: { session?: { getToken(): Promise<string | null> } };
          }
        ).Clerk?.session?.getToken() ?? null,
    );
    if (!token) throw new Error('No Clerk session in the page; is the storage state expired?');
    return { authorization: `Bearer ${token}` };
  }

  async get<T = unknown>(path: string): Promise<T> {
    const response = await this.page.request.get(path, { headers: await this.headers() });
    expect(response.status(), `GET ${path}`).toBe(200);
    return (await response.json()) as T;
  }

  async send(method: 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown) {
    const response = await this.page.request.fetch(path, {
      method,
      data,
      headers: await this.headers(),
    });
    expect(response.ok(), `${method} ${path}`).toBe(true);
    return response;
  }
}

export const message = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
export const noteEditor = (page: Page) =>
  page.locator('[aria-label="Markdown note editor"] .cm-content');

/** Sends a message and waits until the response finishes (Stop response → Send message). */
export async function sendMessage(page: Page, text: string) {
  await message(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
}
