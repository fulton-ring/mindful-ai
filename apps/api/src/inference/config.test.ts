import { afterEach, expect, it, vi } from 'vitest';
import {
  assertInferenceModelAvailable,
  getPublicInferenceConfig,
  resolveInferenceConfig,
} from './config';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const compatible = {
  AI_PROVIDER: 'openai-compatible',
  AI_BASE_URL: 'http://localhost:1234/v1',
  AI_MODEL: 'local-model',
};
it('allows setup with no provider and rejects partial and ambiguous credentials', () => {
  expect(resolveInferenceConfig({})).toEqual({ configured: false });
  expect(() => resolveInferenceConfig({ OPENROUTER_API_KEY: 'or', AI: {} as Ai })).toThrow(
    /ambiguous/i,
  );
  expect(() => resolveInferenceConfig({ CLOUDFLARE_ACCOUNT_ID: 'id' })).toThrow(/incomplete/i);
  expect(() => resolveInferenceConfig({ AI_API_KEY: 'secret' })).toThrow(/incomplete/i);
  expect(() => resolveInferenceConfig({ AI_BASE_URL: 'http://localhost:1234/v1' })).toThrow(
    /AI_MODEL/,
  );
  expect(() => resolveInferenceConfig({ AI_PROVIDER: 'anthropic' })).toThrow(/AI_PROVIDER/);
});
it('infers one provider, honors explicit selection and validates endpoint URLs', () => {
  expect(resolveInferenceConfig({ OPENROUTER_API_KEY: 'or' })).toMatchObject({
    configured: true,
    provider: 'openrouter',
  });
  expect(resolveInferenceConfig({ ...compatible, OPENROUTER_API_KEY: 'unused' })).toMatchObject({
    provider: 'openai-compatible',
    defaultModel: 'local-model',
  });
  expect(() =>
    resolveInferenceConfig({ ...compatible, AI_BASE_URL: 'https://secret@host/v1' }),
  ).toThrow(/AI_BASE_URL/);
  expect(() => resolveInferenceConfig({ ...compatible, AI_BASE_URL: 'file:///tmp/sock' })).toThrow(
    /AI_BASE_URL/,
  );
});
it('exposes only public configuration, including a deployment allowlist with capabilities', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('offline secret'));
  vi.stubGlobal('fetch', fetch);
  const env = {
    ...compatible,
    AI_API_KEY: 'private-key',
    AI_BACKGROUND_MODEL: 'local-model',
    AI_MODELS_JSON: JSON.stringify([
      {
        id: 'local-model',
        name: 'Local',
        supportsTools: true,
        supportsStructuredOutput: true,
        inputModalities: ['text', 'image'],
      },
    ]),
  };
  const result = await getPublicInferenceConfig(env);
  expect(result).toMatchObject({
    configured: true,
    defaultModel: 'local-model',
    catalogSource: 'configured',
    models: [
      {
        id: 'local-model',
        weight: 1,
        supportsTools: true,
        supportsStructuredOutput: true,
        inputModalities: ['text', 'image'],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(/private-key|localhost|offline secret/);
  await expect(assertInferenceModelAvailable(env, 'old-model')).rejects.toThrow(
    /no longer available|not available/,
  );
});
it('discovers metadata, caches it and serves stale catalog after refresh fails', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: [
          {
            id: 'vendor/chat',
            name: 'Chat',
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            supported_parameters: ['tools', 'structured_outputs'],
          },
        ],
      }),
    )
    .mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetch);
  const env = {
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'cache-test-key',
    AI_MODEL: 'vendor/chat',
  };
  expect(await getPublicInferenceConfig(env)).toMatchObject({
    catalogSource: 'discovered',
    catalogStale: false,
    models: [{ id: 'vendor/chat', supportsTools: true, supportsStructuredOutput: true }],
  });
  await assertInferenceModelAvailable(env, 'vendor/chat');
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(6 * 60_000);
  expect(await getPublicInferenceConfig(env)).toMatchObject({
    catalogSource: 'discovered',
    catalogStale: true,
  });
});
it('rejects malformed allowlists and defaults absent from explicit allowlists', async () => {
  expect(() => resolveInferenceConfig({ ...compatible, AI_MODELS_JSON: 'not json' })).toThrow(
    /AI_MODELS_JSON/,
  );
  expect(() => resolveInferenceConfig({ ...compatible, AI_MODELS_JSON: '["another"]' })).toThrow(
    /AI_MODEL/,
  );
  expect(() =>
    resolveInferenceConfig({
      ...compatible,
      AI_MODELS_JSON: '[{"id":"local-model","weight":0}]',
    }),
  ).toThrow(/AI_MODELS_JSON/);
});
it('retains the three Workers AI choices and weights without leaking REST credentials', async () => {
  const publicConfig = await getPublicInferenceConfig({
    CLOUDFLARE_ACCOUNT_ID: 'private-account',
    CLOUDFLARE_API_TOKEN: 'private-token',
  });
  expect(publicConfig).toMatchObject({
    provider: 'cloudflare',
    catalogSource: 'builtin',
    models: [
      { id: '@cf/zai-org/glm-5.3-flash', weight: 1 },
      { id: '@cf/google/gemma-4-26b-a4b-it', weight: 1 },
      { id: '@cf/qwen/qwen3.8-27b', weight: 2 },
    ],
  });
  expect(JSON.stringify(publicConfig)).not.toContain('private-');
  expect(await getPublicInferenceConfig({})).toMatchObject({ configured: false, models: [] });
});
it('rejects models whose discovery metadata rules out chat or tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            id: 'embedding',
            architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
            supported_parameters: [],
          },
        ],
      }),
    ),
  );
  await expect(
    assertInferenceModelAvailable(
      { ...compatible, AI_BASE_URL: 'http://no-tools.test/v1', AI_MODEL: 'embedding' },
      'embedding',
    ),
  ).rejects.toThrow(/text conversations with tools/);
});
it('uses the configured default when discovery is unsupported, never the first model returned', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
  const config = await getPublicInferenceConfig({
    ...compatible,
    AI_BASE_URL: 'http://no-models.test/v1',
  });
  expect(config.models.map(({ id }) => id)).toEqual(['local-model']);
  expect(config.defaultModel).toBe('local-model');
  expect(() => resolveInferenceConfig({ AI_MODEL: 'unbound' })).toThrow(/incomplete/);
});
it('keeps explicit Workers AI model overrides usable alongside the built-in catalog', async () => {
  const catalog = await getPublicInferenceConfig({
    AI: {} as Ai,
    AI_MODEL: '@cf/custom/chat',
    AI_BACKGROUND_MODEL: '@cf/custom/fast',
  });
  expect(catalog.defaultModel).toBe('@cf/custom/chat');
  expect(catalog.models.map(({ id }) => id)).toContain('@cf/custom/chat');
  expect(catalog.models.map(({ id }) => id)).toContain('@cf/custom/fast');
  await expect(
    assertInferenceModelAvailable({ AI: {} as Ai, AI_MODEL: '@cf/custom/chat' }, '@cf/custom/chat'),
  ).resolves.toBeUndefined();
});
