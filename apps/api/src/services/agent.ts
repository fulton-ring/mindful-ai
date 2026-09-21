import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Workspace } from '@mastra/core/workspace';
import type { ChatEvent, Message } from '@walden/contracts';
import { createWorkersAI } from 'workers-ai-provider';
import {
  annotateResponse,
  streamAnnotationResponse,
  streamMastraTurn,
  streamNoteProposal,
} from '../agent';
import { createR2Filesystem } from '../agent/filesystem';
import { type MemoryLifecycleEvent, prepareAgentMemory } from '../agent/memory';
import { captureConversation, contentPreference } from '../content-telemetry';
import { createApiTelemetry } from '../observability';
import { ServiceUnavailableError } from './billing';
import { streamWithEarlyAnnotations } from './early-annotations';
import { createMcpService } from './mcp';
import { createResearchTools, publicUrl } from './research';
import type { AgentService, AgentTurnInput, ServiceEnv } from './types';
import { createWebSearchTools } from './web-search';

export const DEFAULT_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const OPENROUTER_DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';

export async function* streamMemoryPreparation<T>(
  prepare: (emit: (event: MemoryLifecycleEvent) => void) => Promise<T>,
): AsyncGenerator<ChatEvent, T> {
  const queue: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let result: T | undefined;
  let failure: unknown;
  const emit = (event: MemoryLifecycleEvent) => {
    if (event.phase !== 'observation') return;
    if (event.state === 'start') {
      queue.push({ type: 'status', text: 'Compacting conversation context…' });
    } else if (!event.error) {
      if (event.observed) {
        queue.push({ type: 'status', text: 'Context compacted. Thinking…' });
        queue.push({ type: 'context-compacted' });
      } else {
        queue.push({ type: 'status', text: 'Thinking…' });
      }
    }
    wake?.();
    wake = undefined;
  };
  void prepare(emit).then(
    (value) => {
      result = value;
      settled = true;
      wake?.();
    },
    (error) => {
      failure = error;
      settled = true;
      wake?.();
    },
  );
  while (!settled || queue.length) {
    while (queue.length) yield queue.shift()!;
    if (!settled) await new Promise<void>((resolve) => (wake = resolve));
  }
  if (failure) throw failure;
  return result as T;
}

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
  const secondaryContext = (input: AgentTurnInput, signal: AbortSignal | undefined, ms: number) => {
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
  };
  return {
    async streamTurn(input: AgentTurnInput, signal?: AbortSignal) {
      const { modelName, model } = configuredModel();
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => controller.abort('generation deadline exceeded'), 300_000);
      return (async function* () {
        const telemetry = input.telemetryUserId ? createApiTelemetry(env) : null;
        const startedAt = Date.now();
        const preference = await contentPreference(env.DB, input.ownerId);
        let visibleResponse = '';
        let completed = false;
        try {
          const ownerId = input.ownerId;
          let memory: Awaited<ReturnType<typeof prepareAgentMemory>> | undefined;
          if (env.DB && ownerId) {
            const preparation = streamMemoryPreparation((onLifecycle) =>
              prepareAgentMemory(env.DB!, ownerId, input.conversation, {
                model,
                signal: controller.signal,
                onLifecycle,
                isActive: async () =>
                  Boolean(
                    await env
                      .DB!.prepare(
                        "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND expires_at>?",
                      )
                      .bind(input.conversation.id, ownerId, new Date().toISOString())
                      .first(),
                  ),
              }),
            );
            let next = await preparation.next();
            while (!next.done) {
              yield next.value;
              next = await preparation.next();
            }
            memory = next.value;
          }
          const filesystem = ownerId
            ? createR2Filesystem({
                ownerId,
                threadId: input.conversation.id,
                config: {
                  accountId: env.R2_ACCOUNT_ID,
                  bucket: env.R2_BUCKET,
                  accessKeyId: env.R2_ACCESS_KEY_ID,
                  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
                },
              })
            : undefined;
          const workspace = filesystem ? new Workspace({ filesystem }) : undefined;
          const mcpTools = await createMcpService(env).tools();
          const allowedUrls = new Set<string>();
          const userText = [
            input.message,
            ...input.conversation.messages
              .filter((message) => message.role === 'user')
              .map((message) => message.content),
          ].join('\n');
          for (const match of userText.matchAll(/https?:\/\/[^\s<>"`]+/g)) {
            try {
              allowedUrls.add(publicUrl(match[0].replace(/[),.;!?]+$/, '')).toString());
            } catch {
              /* Not a public URL. */
            }
          }
          const stream = streamMastraTurn(
            input,
            model,
            controller.signal,
            {
              ...mcpTools,
              ...createResearchTools(env, ownerId, controller.signal, allowedUrls),
              ...createWebSearchTools(env, controller.signal, allowedUrls),
            },
            telemetry && input.telemetryUserId
              ? { telemetry, userId: input.telemetryUserId, model: modelName }
              : undefined,
            { memory, workspace },
          );
          controller.signal.throwIfAborted();
          const annotatedStream = streamWithEarlyAnnotations(
            stream,
            async (text, annotationSignal) =>
              streamAnnotationResponse(
                text,
                input.turnId,
                model,
                annotationSignal,
                input.conversation.id,
                telemetry && input.telemetryUserId
                  ? { telemetry, userId: input.telemetryUserId, model: modelName }
                  : undefined,
                true,
              ),
            controller.signal,
          );
          for await (const event of annotatedStream) {
            if (event.type === 'text')
              visibleResponse = (visibleResponse + event.text).slice(0, 24_000);
            if (event.type === 'intervention' && event.intervention.kind === 'learning_check')
              visibleResponse = (
                visibleResponse +
                '\n' +
                event.intervention.questions.map(({ question }) => question).join('\n')
              ).slice(0, 24_000);
            yield event;
          }
          completed = true;
        } finally {
          if (preference?.enabled && input.ownerId && input.telemetryUserId) {
            const delivery = captureConversation(env, {
              ownerId: input.ownerId,
              userId: input.telemetryUserId,
              turnId: input.turnId,
              conversationId: input.conversation.id,
              message: input.message,
              response: visibleResponse,
              startedAt,
              preferenceVersion: preference.revision,
              incomplete: !completed,
            });
            if (background) background(delivery);
            else await delivery;
          }
          clearTimeout(deadline);
          signal?.removeEventListener('abort', abort);
          if (telemetry) {
            const cleanup = telemetry.flush();
            if (background) background(cleanup);
            else await cleanup;
          }
        }
      })();
    },
    async annotateTurn(input: AgentTurnInput, assistantMessage: Message, signal?: AbortSignal) {
      if (!assistantMessage.content.trim()) return [];
      const { modelName, model } = configuredModel();
      const secondary = secondaryContext(input, signal, 25_000);
      try {
        return await annotateResponse(
          assistantMessage.content,
          input.turnId,
          model,
          secondary.controller.signal,
          input.conversation.id,
          secondary.telemetry && input.telemetryUserId
            ? {
                telemetry: secondary.telemetry,
                userId: input.telemetryUserId,
                model: modelName,
              }
            : undefined,
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
      const secondary = secondaryContext(input, signal, 25_000);
      const stream = streamAnnotationResponse(
        assistantMessage.content,
        input.turnId,
        model,
        secondary.controller.signal,
        input.conversation.id,
        secondary.telemetry && input.telemetryUserId
          ? { telemetry: secondary.telemetry, userId: input.telemetryUserId, model: modelName }
          : undefined,
        false,
        assistantMessage.annotations?.map(({ quote }) => quote) ?? [],
      );
      return (async function* () {
        try {
          yield* stream;
        } finally {
          await secondary.finish();
        }
      })();
    },
    async streamNoteProposal(
      input: AgentTurnInput,
      assistantMessage: Message,
      signal?: AbortSignal,
    ) {
      const { modelName, model } = configuredModel();
      const secondary = secondaryContext(input, signal, 25_000);
      const stream = streamNoteProposal(
        input,
        assistantMessage,
        model,
        secondary.controller.signal,
        secondary.telemetry && input.telemetryUserId
          ? { telemetry: secondary.telemetry, userId: input.telemetryUserId, model: modelName }
          : undefined,
      );
      return (async function* () {
        try {
          yield* stream;
        } finally {
          await secondary.finish();
        }
      })();
    },
  };
}
