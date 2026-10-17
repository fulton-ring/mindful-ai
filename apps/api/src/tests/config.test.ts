import { expect, it } from 'vitest';
import { app } from '../index';
import type { Bindings } from '../types';

it('exposes only a public PostHog project token, never personal or application secrets', async () => {
  const response = await app.request('/api/config', {}, {
    POSTHOG_API_KEY: 'phc_public',
    OPENROUTER_API_KEY: 'private-model-key',
    CLERK_SECRET_KEY: 'private-auth-key',
    CLERK_PUBLISHABLE_KEY: 'pk_public',
    AI_MODELS_JSON: '["google/gemma-4-26b-a4b-it"]',
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
