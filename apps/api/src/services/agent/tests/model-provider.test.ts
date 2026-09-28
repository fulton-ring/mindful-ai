import { DEFAULT_PERSONAS } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import {
  cloudflareModelSettings,
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
  it('sends each Workers AI model only reasoning settings it accepts', () => {
    expect(cloudflareModelSettings('@cf/zai-org/glm-5.3-flash')).toEqual({
      reasoning_effort: 'low',
    });
    expect(cloudflareModelSettings('@cf/google/gemma-4-26b-a4b-it')).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
    // Qwen 3.8 answers 400 to reasoning_effort 'high'.
    expect(cloudflareModelSettings('@cf/qwen/qwen3.8-27b')).toEqual({ reasoning_effort: 'low' });
  });
});
