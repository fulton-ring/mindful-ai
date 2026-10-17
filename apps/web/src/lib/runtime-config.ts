import { type AppConfig, PERSONA_MODELS, type PublicInferenceConfig } from '@walden/contracts';
import { useSyncExternalStore } from 'react';

let config: AppConfig | undefined;
const listeners = new Set<() => void>();
export function setRuntimeConfig(value: AppConfig | undefined) {
  config = value;
  for (const listener of listeners) listener();
}
export const runtimeConfig = () => config;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useRuntimeConfig() {
  return useSyncExternalStore(subscribe, runtimeConfig);
}
// Older servers expose only boolean config fields; modern empty catalogs stay empty.
const legacyInference: PublicInferenceConfig = {
  configured: true,
  provider: 'cloudflare',
  defaultModel: PERSONA_MODELS[0].id,
  models: PERSONA_MODELS.map(({ id, label, weight }) => ({
    id,
    name: label,
    weight,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsStructuredOutput: true,
  })),
  catalogSource: 'builtin',
  catalogStale: false,
};
export function inferenceConfig(): PublicInferenceConfig {
  return config?.inference ?? legacyInference;
}
export function useInferenceConfig() {
  useRuntimeConfig();
  return inferenceConfig();
}
export function runtimeModelWeight(modelId: string | undefined): number {
  const catalog = inferenceConfig();
  return catalog.models.find(({ id }) => id === (modelId ?? catalog.defaultModel))?.weight ?? 1;
}
