import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type Message, PERSONA_MODELS, type Persona } from '@walden/contracts';
import { createWorkersAI } from 'workers-ai-provider';
import type { AgentCheckpoints } from '../../agent/checkpoints';
import { streamNoteProposal } from '../../agent/note-proposals/note-proposal-stream';
import { agentTrace, annotateResponse, streamAnnotationResponse } from '../../agent/stream-events';
import { ServiceUnavailableError } from '../../http';
import { createApiTelemetry } from '../../observability';
import type { AgentService, AgentTurnInput, ServiceEnv } from '../types';
import { streamTurnEvents } from './agent-stream';

export const DEFAULT_AI_MODEL = PERSONA_MODELS[0].id;
export const OPENROUTER_DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';

type ConfiguredModel = {
  modelName: string;
  model: ReturnType<typeof createConfiguredModel>;
};
type ConfigureModel = (persona: Persona) => ConfiguredModel;
type SecondaryContext = ReturnType<typeof createSecondaryContext>;
type Background = (task: Promise<void>) => void;

export function createCloudflareModel(env: ServiceEnv, modelName: string) {
  // Gemma needs thinking disabled to leave room for visible output. GLM 5.3
  // Flash does not support disabling reasoning, so use its lowest effort.
  const modelSettings =
    modelName === '@cf/google/gemma-4-26b-a4b-it'
      ? ({ reasoning_effort: null, chat_template_kwargs: { enable_thinking: false } } as const)
      : modelName === DEFAULT_AI_MODEL
        ? ({ reasoning_effort: 'low' } as const)
        : {};
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

export function modelNameForPersona(env: ServiceEnv, persona: Persona): string {
  if ((env.AI_PROVIDER ?? 'cloudflare') === 'openrouter')
    return env.AI_MODEL ?? OPENROUTER_DEFAULT_MODEL;
  return persona.model ?? env.AI_MODEL ?? DEFAULT_AI_MODEL;
}

/** Abort on the caller's signal or once `ms` elapses, whichever comes first. */
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function createSecondaryContext(
  env: ServiceEnv,
  background: Background | undefined,
  input: AgentTurnInput,
  modelName: string,
  signal: AbortSignal | undefined,
) {
  const telemetry = input.telemetryUserId ? createApiTelemetry(env) : null;
  const finish = async () => {
    if (!telemetry) return;
    const cleanup = telemetry.flush();
    if (background) background(cleanup);
    else await cleanup;
  };
  return {
    signal: withDeadline(signal, 25_000),
    trace: agentTrace(telemetry, input.telemetryUserId, modelName),
    finish,
  };
}

function createSecondaryOperations(
  env: ServiceEnv,
  background: Background | undefined,
  configuredModel: ConfigureModel,
): Pick<AgentService, 'annotateTurn' | 'streamAnnotations' | 'streamNoteProposal'> {
  const annotationRequest = (
    input: AgentTurnInput,
    assistantMessage: Message,
    signal: AbortSignal | undefined,
  ) => {
    const { modelName, model } = configuredModel(input.persona);
    const secondary = createSecondaryContext(env, background, input, modelName, signal);
    const request = {
      text: assistantMessage.content,
      turnId: input.turnId,
      conversationId: input.conversation.id,
      model,
      signal: secondary.signal,
      trace: secondary.trace,
      excludedQuotes: assistantMessage.annotations?.map(({ quote }) => quote) ?? [],
    };
    return { secondary, request };
  };
  return {
    async annotateTurn(input: AgentTurnInput, assistantMessage: Message, signal?: AbortSignal) {
      if (!assistantMessage.content.trim()) return [];
      const { secondary, request } = annotationRequest(input, assistantMessage, signal);
      try {
        return await annotateResponse(request);
      } finally {
        await secondary.finish();
      }
    },
    async streamAnnotations(
      input: AgentTurnInput,
      assistantMessage: Message,
      signal?: AbortSignal,
    ) {
      const { secondary, request } = annotationRequest(input, assistantMessage, signal);
      return streamWithSecondaryCleanup(streamAnnotationResponse(request), secondary);
    },
    async streamNoteProposal(
      input: AgentTurnInput,
      assistantMessage: Message,
      signal?: AbortSignal,
    ) {
      const { modelName, model } = configuredModel(input.persona);
      const secondary = createSecondaryContext(env, background, input, modelName, signal);
      const stream = streamNoteProposal(
        input,
        assistantMessage,
        model,
        secondary.signal,
        secondary.trace,
      );
      return streamWithSecondaryCleanup(stream, secondary);
    },
  };
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

/** A durable turn may run across Workflow steps, so its deadline is generous. */
const TURN_DEADLINE_MS = 15 * 60_000;

/**
 * `background` defers telemetry flushes past the response (request handlers
 * pass `waitUntil`); without it they are awaited inline.
 */
export function createAgentService(env: ServiceEnv, background?: Background): AgentService {
  const configuredModel: ConfigureModel = (persona) => {
    const modelName = modelNameForPersona(env, persona);
    return { modelName, model: createConfiguredModel(env, modelName) };
  };
  return {
    async streamTurn(input: AgentTurnInput, checkpoints: AgentCheckpoints, signal?: AbortSignal) {
      const { modelName, model } = configuredModel(input.persona);
      return streamTurnEvents({
        env,
        input,
        modelName,
        model,
        signal: withDeadline(signal, TURN_DEADLINE_MS),
        checkpoints,
        background,
      });
    },
    ...createSecondaryOperations(env, background, configuredModel),
  };
}
