import { DEFAULT_PERSONAS } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import {
  createConfiguredModel,
  DEFAULT_AI_MODEL,
  modelNameForPersona,
  OPENROUTER_DEFAULT_MODEL,
} from '../agent';

describe('configured model provider', () => {
  it('defaults to GLM 5.3 Flash on Cloudflare', () => {
    expect(DEFAULT_AI_MODEL).toBe('@cf/zai-org/glm-5.3-flash');
    expect(modelNameForPersona({}, DEFAULT_PERSONAS[0]!)).toBe(DEFAULT_AI_MODEL);
    expect(
      modelNameForPersona(
        { AI_MODEL: DEFAULT_AI_MODEL },
        { ...DEFAULT_PERSONAS[0]!, model: '@cf/google/gemma-4-26b-a4b-it' },
      ),
    ).toBe('@cf/google/gemma-4-26b-a4b-it');
  });
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
