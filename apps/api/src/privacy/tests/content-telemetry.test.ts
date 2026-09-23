import { afterEach, expect, it, vi } from 'vitest';
import { captureConversation, redactContent } from '../content-telemetry';

afterEach(() => vi.unstubAllGlobals());
it('redacts credentials and contact details without removing useful prose', () => {
  expect(redactContent('Hello a@b.com password=hunter2 sk-abcdefghijklmno')).toBe(
    'Hello [redacted] password=[redacted] [redacted]',
  );
});
it('never sends content without an acknowledged enabled preference', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const DB = {
    prepare: () => ({ bind: () => ({ first: async () => null }) }),
  } as unknown as D1Database;
  await captureConversation(
    {
      DB,
      POSTHOG_API_KEY: 'key',
      POSTHOG_PERSONAL_API_KEY: 'management',
      POSTHOG_PROJECT_ID: 'project',
    },
    {
      ownerId: 'a',
      userId: 'u',
      turnId: 't',
      conversationId: 'c',
      message: 'secret',
      response: 'answer',
      startedAt: Date.now(),
      preferenceVersion: 'v',
    },
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('drops an in-flight export when the preference changed', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const DB = {
    prepare: () => ({ bind: () => ({ first: async () => ({ enabled: 1, revision: 'new' }) }) }),
  } as unknown as D1Database;
  await captureConversation(
    {
      DB,
      POSTHOG_API_KEY: 'key',
      POSTHOG_PERSONAL_API_KEY: 'management',
      POSTHOG_PROJECT_ID: 'project',
    },
    {
      ownerId: 'a',
      userId: 'u',
      turnId: 't',
      conversationId: 'c',
      message: 'secret',
      response: 'answer',
      startedAt: Date.now(),
      preferenceVersion: 'old',
    },
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('exports only redacted visible content in short-retention AI properties', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const DB = {
    prepare: () => ({ bind: () => ({ first: async () => ({ enabled: 1, revision: 'same' }) }) }),
  } as unknown as D1Database;
  await captureConversation(
    {
      DB,
      POSTHOG_API_KEY: 'key',
      POSTHOG_PERSONAL_API_KEY: 'management',
      POSTHOG_PROJECT_ID: 'project',
    },
    {
      ownerId: 'a',
      userId: 'u',
      turnId: 't',
      conversationId: 'c',
      message: 'password=hunter2',
      response: 'Useful answer',
      startedAt: Date.now(),
      preferenceVersion: 'same',
    },
  );
  const payload = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(payload.event).toBe('$ai_trace');
  expect(payload.properties.$ai_input_state).toEqual({ message: 'password=[redacted]' });
  expect(payload.properties.$ai_output_state).toEqual({ response: 'Useful answer' });
  expect(JSON.stringify(payload)).not.toContain('hunter2');
});

it('does not collect content while provider deletion is unconfigured', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const DB = {
    prepare: () => ({ bind: () => ({ first: async () => ({ enabled: 1, revision: 'same' }) }) }),
  } as unknown as D1Database;
  await captureConversation(
    { DB, POSTHOG_API_KEY: 'key' },
    {
      ownerId: 'a',
      userId: 'u',
      turnId: 't',
      conversationId: 'c',
      message: 'private',
      response: 'answer',
      startedAt: Date.now(),
      preferenceVersion: 'same',
    },
  );
  expect(fetch).not.toHaveBeenCalled();
});
