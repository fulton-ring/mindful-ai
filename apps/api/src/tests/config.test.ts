import { expect, it } from 'vitest';
import { app } from '../index';
import type { Bindings } from '../types';

it('exposes only a public PostHog project token, never personal or application secrets', async () => {
  const response = await app.request('/api/config', {}, {
    POSTHOG_API_KEY: 'phc_public',
    OPENROUTER_API_KEY: 'private-model-key',
    CLERK_SECRET_KEY: 'private-auth-key',
  } as Bindings);
  const body = await response.json();
  expect(body).toMatchObject({
    telemetry: { key: 'phc_public', host: 'https://us.i.posthog.com' },
  });
  expect(JSON.stringify(body)).not.toContain('private-');
  const personal = await app.request('/api/config', {}, {
    POSTHOG_API_KEY: 'phx_private',
  } as Bindings);
  expect(await personal.json()).not.toHaveProperty('telemetry');
});
