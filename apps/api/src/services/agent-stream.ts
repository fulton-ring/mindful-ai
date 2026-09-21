import { Workspace } from '@mastra/core/workspace';
import type { ChatEvent } from '@walden/contracts';
import type {
  AgentRuntime,
  AgentTraceContext,
  streamAnnotationResponse,
  streamMastraTurn,
} from '../agent';
import { createR2Filesystem } from '../agent/filesystem';
import { type MemoryLifecycleEvent, prepareAgentMemory } from '../agent/memory';
import { captureConversation, contentPreference } from '../content-telemetry';
import { type ApiTelemetry, createApiTelemetry } from '../observability';
import { streamMemoryPreparation } from './agent-memory-stream';
import { streamWithEarlyAnnotations } from './early-annotations';
import { createMcpService, type McpTools } from './mcp';
import { createResearchTools, publicUrl } from './research';
import type { AgentTurnInput, ServiceEnv } from './types';
import { createWebSearchTools } from './web-search';

type AgentModel = Parameters<typeof prepareAgentMemory>[2]['model'];

export type TurnStreamContext = {
  controller: AbortController;
  cleanup: () => void;
};

type StreamDependencies = {
  streamMastraTurn: typeof streamMastraTurn;
  streamAnnotationResponse: typeof streamAnnotationResponse;
};

type TurnStreamOptions = StreamDependencies & {
  env: ServiceEnv;
  input: AgentTurnInput;
  modelName: string;
  model: AgentModel;
  context: TurnStreamContext;
  background?: (task: Promise<void>) => void;
};

function collectAllowedUrls(input: AgentTurnInput): Set<string> {
  const userText = [
    input.message,
    ...input.conversation.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
  ].join('\n');
  const allowedUrls = new Set<string>();
  for (const match of userText.matchAll(/https?:\/\/[^\s<>"`]+/g)) {
    try {
      allowedUrls.add(publicUrl(match[0].replace(/[),.;!?]+$/, '')).toString());
    } catch {
      /* Not a public URL. */
    }
  }
  return allowedUrls;
}

async function* prepareTurnMemory(
  env: ServiceEnv,
  input: AgentTurnInput,
  model: AgentModel,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent, Awaited<ReturnType<typeof prepareAgentMemory>> | undefined> {
  const { ownerId } = input;
  if (!env.DB || !ownerId) return;
  const preparation = streamMemoryPreparation(
    (onLifecycle: (event: MemoryLifecycleEvent) => void) =>
      prepareAgentMemory(env.DB!, ownerId, input.conversation, {
        model,
        signal,
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
  return next.value;
}

function createTurnWorkspace(env: ServiceEnv, input: AgentTurnInput): Workspace | undefined {
  if (!input.ownerId) return undefined;
  const filesystem = createR2Filesystem({
    ownerId: input.ownerId,
    threadId: input.conversation.id,
    config: {
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return new Workspace({ filesystem });
}

async function createPrimaryStream(
  options: TurnStreamOptions,
  memory: Awaited<ReturnType<typeof prepareAgentMemory>> | undefined,
  workspace: Workspace | undefined,
  telemetry: ApiTelemetry | null,
): Promise<AsyncIterable<ChatEvent>> {
  const { env, input, model, modelName, context } = options;
  const mcpTools = await createMcpService(env).tools();
  const allowedUrls = collectAllowedUrls(input);
  const tools: McpTools = {
    ...mcpTools,
    ...createResearchTools(env, input.ownerId, context.controller.signal, allowedUrls),
    ...createWebSearchTools(env, context.controller.signal, allowedUrls),
  };
  const trace: AgentTraceContext | undefined =
    telemetry && input.telemetryUserId
      ? { telemetry, userId: input.telemetryUserId, model: modelName }
      : undefined;
  const runtime: AgentRuntime = { memory, workspace };
  return options.streamMastraTurn(input, model, context.controller.signal, tools, trace, runtime);
}

function createAnnotatedStream(
  options: TurnStreamOptions,
  stream: AsyncIterable<ChatEvent>,
  telemetry: ApiTelemetry | null,
): AsyncIterable<ChatEvent> {
  const { input, model, modelName, context } = options;
  const trace: AgentTraceContext | undefined =
    telemetry && input.telemetryUserId
      ? { telemetry, userId: input.telemetryUserId, model: modelName }
      : undefined;
  return streamWithEarlyAnnotations(
    stream,
    async (text, annotationSignal) =>
      options.streamAnnotationResponse(
        text,
        input.turnId,
        model,
        annotationSignal,
        input.conversation.id,
        trace,
        true,
      ),
    context.controller.signal,
  );
}

function appendVisibleResponse(visibleResponse: string, event: ChatEvent): string {
  if (event.type === 'text') return (visibleResponse + event.text).slice(0, 24_000);
  if (event.type !== 'intervention' || event.intervention.kind !== 'learning_check') {
    return visibleResponse;
  }
  return (
    visibleResponse +
    '\n' +
    event.intervention.questions.map(({ question }) => question).join('\n')
  ).slice(0, 24_000);
}

async function finishTurnStream(
  options: TurnStreamOptions,
  preference: Awaited<ReturnType<typeof contentPreference>>,
  telemetry: ApiTelemetry | null,
  visibleResponse: string,
  startedAt: number,
  completed: boolean,
): Promise<void> {
  const { env, input, background, context } = options;
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
  context.cleanup();
  if (!telemetry) return;
  const cleanup = telemetry.flush();
  if (background) background(cleanup);
  else await cleanup;
}

async function* runTurnStream(options: TurnStreamOptions): AsyncGenerator<ChatEvent> {
  const { env, input, model } = options;
  const telemetry = input.telemetryUserId ? createApiTelemetry(env) : null;
  const startedAt = Date.now();
  const preference = await contentPreference(env.DB, input.ownerId);
  let visibleResponse = '';
  let completed = false;
  try {
    const memory = yield* prepareTurnMemory(env, input, model, options.context.controller.signal);
    const workspace = createTurnWorkspace(env, input);
    const stream = await createPrimaryStream(options, memory, workspace, telemetry);
    options.context.controller.signal.throwIfAborted();
    const annotatedStream = createAnnotatedStream(options, stream, telemetry);
    for await (const event of annotatedStream) {
      visibleResponse = appendVisibleResponse(visibleResponse, event);
      yield event;
    }
    completed = true;
  } finally {
    await finishTurnStream(options, preference, telemetry, visibleResponse, startedAt, completed);
  }
}

export function streamTurnEvents(options: TurnStreamOptions): AsyncIterable<ChatEvent> {
  return runTurnStream(options);
}
