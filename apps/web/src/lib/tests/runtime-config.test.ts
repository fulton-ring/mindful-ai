import type { AppConfig } from '@walden/contracts';
import { afterEach, expect, it } from 'vitest';
import { inferenceConfig, runtimeModelWeight, setRuntimeConfig } from '../runtime-config';

afterEach(() => setRuntimeConfig(undefined));
it('uses server catalog defaults and weights without inventing models for unconfigured instances', () => {
  setRuntimeConfig({
    inference: {
      configured: true,
      provider: 'openai-compatible',
      defaultModel: 'local',
      models: [
        {
          id: 'local',
          name: 'Local',
          weight: 3,
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsStructuredOutput: null,
        },
      ],
      catalogSource: 'configured',
      catalogStale: false,
    },
  } as AppConfig);
  expect(inferenceConfig().models.map(({ id }) => id)).toEqual(['local']);
  expect(runtimeModelWeight(undefined)).toBe(3);
  setRuntimeConfig({
    inference: { configured: false, models: [], catalogSource: 'unavailable', catalogStale: false },
  } as unknown as AppConfig);
  expect(inferenceConfig().models).toEqual([]);
  setRuntimeConfig(undefined);
  expect(inferenceConfig().models).toHaveLength(3);
});
