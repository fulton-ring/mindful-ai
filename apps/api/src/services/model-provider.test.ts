import { describe, expect, it } from 'vitest';
import { createConfiguredModel, OPENROUTER_DEFAULT_MODEL } from './agent';

describe('configured model provider', () => {
  it('uses the OpenRouter-compatible endpoint when selected', () => {
    const model = createConfiguredModel(
      {
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'test-key',
      },
      OPENROUTER_DEFAULT_MODEL,
    );

    expect(model.provider).toBe('openrouter.chat');
    expect(model.modelId).toBe(OPENROUTER_DEFAULT_MODEL);
  });
});
