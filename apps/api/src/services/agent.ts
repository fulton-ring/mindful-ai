import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Message } from '@walden/contracts';
import { createWorkersAI } from 'workers-ai-provider';
import {
  annotateResponse,
  streamAnnotationResponse,
  streamMastraTurn,
  streamNoteProposal,
} from '../agent';
import { createApiTelemetry } from '../observability';
import { streamTurnEvents, type TurnStreamContext } from './agent-stream';
import { ServiceUnavailableError } from './billing';
import type { AgentService, AgentTurnInput, ServiceEnv } from './types';

export const DEFAULT_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const OPENROUTER_DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';

type ConfiguredModel = {
  modelName: string;
  model: ReturnType<typeof createConfiguredModel>;
};
type ConfigureModel = () => ConfiguredModel;
type SecondaryContext = ReturnType<typeof createSecondaryContext>;

export { streamMemoryPreparation } from './agent-memory-stream';

export function createCloudflareModel(env: ServiceEnv, modelName: string) {
  // Gemma can otherwise spend the entire output budget on hidden reasoning,
  // producing a successful response with no user-visible text.
  const modelSettings = {
    reasoning_effort: null,
    chat_template_kwargs: { enable_thinking: false },
  } as const;
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    return createWorkersAI({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: env.CLOUDFLARE_API_TOKEN,
    })(modelName, modelSettings);
  }
  if (env.AI) return createWorkersAI({ binding: env.AI })(modelName, modelSettings);
  throw new ServiceUnavailableError(
    'AI inference is not configured. Set Cloudflare REST credentials for local development or configure the AI binding in Workers.',
  );
}

export function createConfiguredModel(env: ServiceEnv, modelName: string) {
  if ((env.AI_PROVIDER ?? 'cloudflare') === 'openrouter') {
    if (!env.OPENROUTER_API_KEY)
      throw new ServiceUnavailableError('AI inference is not configured. Set OPENROUTER_API_KEY.');
    return createOpenAICompatible({
      name: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      includeUsage: true,
    }).chatModel(modelName);
  }
  return createCloudflareModel(env, modelName);
}

function createSecondaryContext(
  env: ServiceEnv,
  background: ((task: Promise<void>) => void) | undefined,
  input: AgentTurnInput,
  signal: AbortSignal | undefined,
  ms: number,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => controller.abort('generation deadline exceeded'), ms);
  const telemetry = input.telemetryUserId ? createApiTelemetry(env) : null;
  const finish = async () => {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    if (!telemetry) return;
    const cleanup = telemetry.flush();
    if (background) background(cleanup);
    else await cleanup;
  };
  return { controller, telemetry, finish };
}

function createSecondaryOperations(
  env: ServiceEnv,
  background: ((task: Promise<void>) => void) | undefined,
  configuredModel: ConfigureModel,
): Pick<AgentService, 'annotateTurn' | 'streamAnnotations' | 'streamNoteProposal'> {
  return {
    async annotateTurn(input: AgentTurnInput, assistantMessage: Message, signal?: AbortSignal) {
      if (!assistantMessage.content.trim()) return [];
      const { modelName, model } = configuredModel();
      const secondary = createSecondaryContext(env, background, input, signal, 25_000);
      try {
        return await annotateResponse(
          assistantMessage.content,
          input.turnId,
          model,
          secondary.controller.signal,
          input.conversation.id,
          secondaryTrace(secondary, input, modelName),
          assistantMessage.annotations?.map(({ quote }) => quote) ?? [],
        );
      } finally {
        await secondary.finish();
      }
    },
    async streamAnnotations(
      input: AgentTurnInput,
      assistantMessage: Message,
      signal?: AbortSignal,
    ) {
      const { modelName, model } = configuredModel();
      const secondary = createSecondaryContext(env, background, input, signal, 25_000);
      const stream = streamAnnotationResponse(
        assistantMessage.content,
        input.turnId,
        model,
        secondary.controller.signal,
        input.conversation.id,
        secondaryTrace(secondary, input, modelName),
        false,
        assistantMessage.annotations?.map(({ quote }) => quote) ?? [],
      );
      return streamWithSecondaryCleanup(stream, secondary);
    },
    async streamNoteProposal(
      input: AgentTurnInput,
      assistantMessage: Message,
      signal?: AbortSignal,
    ) {
      const { modelName, model } = configuredModel();
      const secondary = createSecondaryContext(env, background, input, signal, 25_000);
      const stream = streamNoteProposal(
        input,
        assistantMessage,
        model,
        secondary.controller.signal,
        secondaryTrace(secondary, input, modelName),
      );
      return streamWithSecondaryCleanup(stream, secondary);
    },
  };
}

function secondaryTrace(secondary: SecondaryContext, input: AgentTurnInput, modelName: string) {
  return secondary.telemetry && input.telemetryUserId
    ? { telemetry: secondary.telemetry, userId: input.telemetryUserId, model: modelName }
    : undefined;
}

function streamWithSecondaryCleanup<T>(
  stream: AsyncIterable<T>,
  secondary: SecondaryContext,
): AsyncIterable<T> {
  return (async function* () {
    try {
      yield* stream;
    } finally {
      await secondary.finish();
    }
  })();
}

export function createAgentService(
  env: ServiceEnv,
  background?: (task: Promise<void>) => void,
): AgentService {
  const configuredModel = () => {
    const provider = env.AI_PROVIDER ?? 'cloudflare';
    const modelName =
      env.AI_MODEL ?? (provider === 'openrouter' ? OPENROUTER_DEFAULT_MODEL : DEFAULT_AI_MODEL);
    return { modelName, model: createConfiguredModel(env, modelName) };
  };
  return {
    async streamTurn(input: AgentTurnInput, signal?: AbortSignal) {
      const { modelName, model } = configuredModel();
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => controller.abort('generation deadline exceeded'), 300_000);
      const context: TurnStreamContext = {
        controller,
        cleanup: () => {
          clearTimeout(deadline);
          signal?.removeEventListener('abort', abort);
        },
      };
      return streamTurnEvents({
        env,
        input,
        modelName,
        model,
        context,
        background,
        streamMastraTurn,
        streamAnnotationResponse,
      });
    },
    ...createSecondaryOperations(env, background, configuredModel),
  };
}
