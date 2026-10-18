import { type InferenceModel, PERSONA_MODELS, type PublicInferenceConfig } from '@walden/contracts';
import { z } from 'zod';
import { HttpError, ServiceUnavailableError } from '../http';
import type { ServiceEnv } from '../services/types';

export const DEFAULT_AI_MODEL = PERSONA_MODELS[0].id;
export const OPENROUTER_DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';
export type InferenceProvider = 'cloudflare' | 'openrouter' | 'openai-compatible';
export type { InferenceModel, PublicInferenceConfig };
export type InferenceConfig =
  | { configured: false }
  | {
      configured: true;
      provider: InferenceProvider;
      defaultModel: string;
      backgroundModel: string;
      apiKey?: string;
      baseURL?: string;
      models?: InferenceModel[];
    };
const modelId = z.string().trim().min(1).max(256);
const modelSchema = z.object({
  id: modelId,
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(4000).optional(),
  weight: z.number().int().min(1).max(3).optional(),
  inputModalities: z.array(z.string().min(1).max(32)).min(1).max(16).optional(),
  outputModalities: z.array(z.string().min(1).max(32)).min(1).max(16).optional(),
  supportsTools: z.boolean().nullable().optional(),
  supportsStructuredOutput: z.boolean().nullable().optional(),
});
const weightFor = (id: string) => PERSONA_MODELS.find((model) => model.id === id)?.weight ?? 1;
function normalizeModel(value: z.infer<typeof modelSchema>): InferenceModel {
  return {
    ...value,
    name: value.name ?? value.id,
    weight: value.weight ?? weightFor(value.id),
    inputModalities: value.inputModalities ?? ['text'],
    outputModalities: value.outputModalities ?? ['text'],
    supportsTools: value.supportsTools ?? null,
    supportsStructuredOutput: value.supportsStructuredOutput ?? null,
  };
}
function configuredModels(raw: string | undefined): InferenceModel[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const values = z
      .array(z.union([modelId, modelSchema]))
      .min(1)
      .max(2000)
      .parse(JSON.parse(raw));
    const models = values.map((value) =>
      normalizeModel(typeof value === 'string' ? { id: value } : value),
    );
    if (new Set(models.map(({ id }) => id)).size !== models.length) throw new Error();
    return models;
  } catch {
    throw new ServiceUnavailableError(
      'Invalid AI_MODELS_JSON. Provide a nonempty JSON array of unique model IDs or model metadata.',
    );
  }
}
function baseURL(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? '');
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new ServiceUnavailableError(
      'Invalid AI_BASE_URL. Use an HTTP(S) API URL without credentials, query parameters or fragments.',
    );
  }
}
function configuredProvider(env: ServiceEnv): InferenceProvider | undefined {
  let provider = env.AI_PROVIDER?.trim();
  if (provider && !['cloudflare', 'openrouter', 'openai-compatible'].includes(provider))
    throw new ServiceUnavailableError(
      'Invalid AI_PROVIDER. Use cloudflare, openrouter or openai-compatible.',
    );
  if (!provider) {
    const families = [
      env.AI || env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_API_TOKEN ? 'cloudflare' : null,
      env.OPENROUTER_API_KEY ? 'openrouter' : null,
      env.AI_BASE_URL || env.AI_API_KEY ? 'openai-compatible' : null,
    ].filter(Boolean);
    if (families.length > 1)
      throw new ServiceUnavailableError(
        'AI inference configuration is ambiguous. Set AI_PROVIDER explicitly.',
      );
    provider = families[0] ?? undefined;
    if (!provider) {
      if (env.AI_MODEL || env.AI_BACKGROUND_MODEL || env.AI_MODELS_JSON)
        throw new ServiceUnavailableError(
          'AI inference configuration is incomplete. Configure AI_PROVIDER and its credentials.',
        );
      return undefined;
    }
  }
  return provider as InferenceProvider;
}
function providerConnection(env: ServiceEnv, provider: InferenceProvider) {
  if (
    provider === 'cloudflare' &&
    !env.AI &&
    !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
  )
    throw new ServiceUnavailableError(
      'Cloudflare AI configuration is incomplete. Configure the AI binding or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
    );
  if (provider === 'openrouter' && !env.OPENROUTER_API_KEY)
    throw new ServiceUnavailableError(
      'OpenRouter AI configuration is incomplete. Set OPENROUTER_API_KEY.',
    );
  if (provider === 'openai-compatible' && !env.AI_BASE_URL)
    throw new ServiceUnavailableError(
      'Compatible AI configuration is incomplete. Set AI_BASE_URL and AI_MODEL.',
    );
  if (provider === 'openrouter')
    return { apiKey: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' };
  if (provider === 'openai-compatible')
    return { apiKey: env.AI_API_KEY, baseURL: baseURL(env.AI_BASE_URL) };
  return {};
}
export function resolveInferenceConfig(env: ServiceEnv): InferenceConfig {
  const provider = configuredProvider(env);
  if (!provider) return { configured: false };
  const connection = providerConnection(env, provider);
  const defaultModel =
    env.AI_MODEL?.trim() ||
    (provider === 'cloudflare'
      ? DEFAULT_AI_MODEL
      : provider === 'openrouter'
        ? OPENROUTER_DEFAULT_MODEL
        : undefined);
  if (!defaultModel || !modelId.safeParse(defaultModel).success)
    throw new ServiceUnavailableError('Set AI_MODEL to the default model ID for your endpoint.');
  const backgroundModel = env.AI_BACKGROUND_MODEL?.trim() || defaultModel;
  if (!modelId.safeParse(backgroundModel).success)
    throw new ServiceUnavailableError('Invalid AI_BACKGROUND_MODEL.');
  const models = configuredModels(env.AI_MODELS_JSON);
  if (models && !models.some(({ id }) => id === defaultModel))
    throw new ServiceUnavailableError('AI_MODEL must appear in AI_MODELS_JSON.');
  if (models && !models.some(({ id }) => id === backgroundModel))
    throw new ServiceUnavailableError('AI_BACKGROUND_MODEL must appear in AI_MODELS_JSON.');
  return {
    configured: true,
    provider,
    defaultModel,
    backgroundModel,
    models,
    ...connection,
  };
}
export function requireInferenceConfig(
  env: ServiceEnv,
): Extract<InferenceConfig, { configured: true }> {
  const config = resolveInferenceConfig(env);
  if (!config.configured)
    throw new ServiceUnavailableError(
      'AI inference is not configured. Configure an inference provider in the server environment.',
    );
  return config;
}

const builtins = PERSONA_MODELS.map(({ id, label, weight }) =>
  normalizeModel({ id, name: label, weight, supportsTools: true, supportsStructuredOutput: true }),
);
function cloudflareCatalog(
  config: Extract<InferenceConfig, { configured: true }>,
): InferenceModel[] {
  const ids = new Set(builtins.map(({ id }) => id));
  return [
    ...builtins,
    ...[...new Set([config.defaultModel, config.backgroundModel])]
      .filter((id) => !ids.has(id))
      .map((id) => normalizeModel({ id })),
  ];
}
type CachedCatalog = {
  models: InferenceModel[];
  expires: number;
  retryAfter?: number;
  pending?: Promise<InferenceModel[]>;
};
// Isolate-local cache; credentials are part of the key and never exposed publicly.
const catalogs = new Map<string, CachedCatalog>();
const discoveryModelSchema = z.object({
  id: modelId,
  name: z.string().optional(),
  description: z.string().optional(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
});
async function discover(
  config: Extract<InferenceConfig, { configured: true }>,
): Promise<InferenceModel[]> {
  const response = await fetch(`${config.baseURL}/models`, {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Model discovery unavailable');
  }
  const body = z
    .object({ data: z.array(discoveryModelSchema).max(10000) })
    .parse(await response.json());
  return body.data.map((item) =>
    normalizeModel({
      id: item.id,
      name: item.name?.slice(0, 256),
      description: item.description?.slice(0, 4000),
      inputModalities: item.architecture?.input_modalities,
      outputModalities: item.architecture?.output_modalities,
      supportsTools: item.supported_parameters ? item.supported_parameters.includes('tools') : null,
      supportsStructuredOutput: item.supported_parameters
        ? item.supported_parameters.includes('structured_outputs')
        : null,
    }),
  );
}
export async function getPublicInferenceConfig(env: ServiceEnv): Promise<PublicInferenceConfig> {
  const config = resolveInferenceConfig(env);
  if (!config.configured)
    return { configured: false, models: [], catalogSource: 'unavailable', catalogStale: false };
  const publicConfig = {
    configured: true,
    provider: config.provider,
    defaultModel: config.defaultModel,
  };
  if (config.models)
    return {
      ...publicConfig,
      models: config.models,
      catalogSource: 'configured',
      catalogStale: false,
    };
  if (config.provider === 'cloudflare')
    return {
      ...publicConfig,
      models: cloudflareCatalog(config),
      catalogSource: 'builtin',
      catalogStale: false,
    };
  const key = `${config.provider}:${config.baseURL}:${config.apiKey ?? ''}`;
  let cached = catalogs.get(key);
  const now = Date.now();
  if (cached && cached.expires > now)
    return {
      ...publicConfig,
      models: cached.models,
      catalogSource: 'discovered',
      catalogStale: false,
    };
  if (!cached?.retryAfter || cached.retryAfter <= now) {
    cached ??= { models: [], expires: 0 };
    // Bound memory in long-lived servers with many runtime configurations.
    if (catalogs.size >= 32 && !catalogs.has(key)) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(key, cached);
    cached.pending ??= discover(config);
    try {
      cached.models = await cached.pending;
      cached.expires = Date.now() + 5 * 60_000;
      cached.retryAfter = undefined;
    } catch {
      cached.retryAfter = Date.now() + 30_000;
    } finally {
      cached.pending = undefined;
    }
  }
  if (cached && cached.expires > 0)
    return {
      ...publicConfig,
      models: cached.models,
      catalogSource: 'discovered',
      catalogStale: cached.expires <= Date.now(),
    };
  // Explicit server model IDs are a usable fallback when /models is unsupported.
  const ids = [...new Set([config.defaultModel, config.backgroundModel])];
  return {
    ...publicConfig,
    models: ids.map((id) => normalizeModel({ id })),
    catalogSource: 'configured',
    catalogStale: false,
  };
}
export async function assertInferenceModelAvailable(
  env: ServiceEnv,
  modelName: string,
): Promise<void> {
  requireInferenceConfig(env);
  validateInferenceModel(modelName, await getPublicInferenceConfig(env));
}

/** Admission and persona mutations use identical capability checks before any charge. */
export function validateInferenceModel(
  modelName: string,
  catalog: PublicInferenceConfig,
): InferenceModel {
  if (!catalog.configured) throw new ServiceUnavailableError('AI inference is not configured.');
  const model = catalog.models.find(({ id }) => id === modelName);
  if (!model)
    throw new HttpError(
      422,
      'This model is not available on the configured inference provider. Select an available model in the persona settings.',
    );
  if (
    !model.inputModalities.includes('text') ||
    !model.outputModalities.includes('text') ||
    model.supportsTools === false
  )
    throw new HttpError(
      422,
      'This model does not support text conversations with tools. Select a compatible model in the persona settings.',
    );
  return model;
}

/** Metadata already loaded at admission, without another network request. */
export function getCachedInferenceModel(
  env: ServiceEnv,
  modelName: string,
): InferenceModel | undefined {
  const config = requireInferenceConfig(env);
  const models =
    config.models ??
    (config.provider === 'cloudflare'
      ? cloudflareCatalog(config)
      : catalogs.get(`${config.provider}:${config.baseURL}:${config.apiKey ?? ''}`)?.models);
  return models?.find(({ id }) => id === modelName);
}
