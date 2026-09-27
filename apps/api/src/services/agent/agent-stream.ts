import { Workspace } from '@mastra/core/workspace';
import type { ChatEvent } from '@walden/contracts';
import { type AgentCheckpoints, checkpointModel } from '../../agent/checkpoints';
import { createDocumentTools } from '../../agent/document-tool';
import { GemmaToolLeakDecoder } from '../../agent/learning-checks';
import { streamMastraTurn } from '../../agent/mastra-turn';
import { type MemoryLifecycleEvent, prepareAgentMemory } from '../../agent/memory/memory';
import { R2WorkspaceFilesystem } from '../../agent/r2-workspace';
import { agentTrace } from '../../agent/stream-events';
import { loadAttachments } from '../../chat/attachments/attachments';
import { isConversationLive } from '../../chat/turns/durable-store';
import { type ApiTelemetry, createApiTelemetry } from '../../observability';
import { captureConversation, contentPreference } from '../../privacy/content-telemetry';
import { createMcpService, type McpTools } from '../mcp';
import { createResearchTools, publicUrl } from '../research/research';
import { createWebSearchTools } from '../research/web-search';
import type { AgentTurnInput, ServiceEnv } from '../types';
import { streamMemoryPreparation } from './agent-memory-stream';

type AgentModel = Parameters<typeof prepareAgentMemory>[3]['model'];

type TurnStreamOptions = {
  env: ServiceEnv;
  input: AgentTurnInput;
  modelName: string;
  model: AgentModel;
  /** Aborts on cancellation or the turn deadline. */
  signal: AbortSignal;
  checkpoints: AgentCheckpoints;
  /** Runs work after the turn commits; telemetry must not delay the reply. */
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

function restoreSearchUrls(allowedUrls: Set<string>) {
  return (name: string, result: unknown) => {
    if (name !== 'searchWeb' && name !== 'searchSources') return;
    if (
      !result ||
      typeof result !== 'object' ||
      !('results' in result) ||
      !Array.isArray(result.results)
    )
      return;
    for (const source of result.results) {
      if (!source || typeof source.url !== 'string') continue;
      try {
        allowedUrls.add(publicUrl(source.url).toString());
      } catch {
        /* Invalid URL. */
      }
    }
  };
}

function modelProgress(checkpoints: AgentCheckpoints) {
  if (!checkpoints.publish) return undefined;
  const previews = new Map<string, { text: string; reasoning: string }>();
  return async (step: string, text: string, reasoning: string, complete: boolean) => {
    const decoder = new GemmaToolLeakDecoder();
    const visible = decoder.push(text).text + (complete ? decoder.finish() : '');
    previews.set(step, { text: visible, reasoning });
    await checkpoints.publish!({
      type: 'text-snapshot',
      text: [...previews.values()].map((value) => value.text).join(''),
      reasoning: [...previews.values()].map((value) => value.reasoning).join(''),
    });
  };
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
        isActive: () => isConversationLive(env.DB!, ownerId, input.conversation.id),
      }),
  );
  let next = await preparation.next();
  while (!next.done) {
    yield next.value;
    next = await preparation.next();
  }
  return next.value;
}

export function createTurnWorkspace(env: ServiceEnv, input: AgentTurnInput): Workspace | undefined {
  if (!input.ownerId || !env.FILES) return undefined;
  return new Workspace({
    filesystem: new R2WorkspaceFilesystem(env.FILES, input.ownerId, input.conversation.id),
  });
}

export async function includeRecentImage(
  env: ServiceEnv,
  input: AgentTurnInput,
): Promise<AgentTurnInput> {
  if (!env.FILES || !input.ownerId || input.attachments?.some(({ bytes }) => bytes)) return input;
  const recentImage = input.conversation.messages
    .flatMap((message) => message.attachments ?? [])
    .reverse()
    .find(({ mimeType }) => mimeType.startsWith('image/'));
  if (!recentImage) return input;
  try {
    const [image] = await loadAttachments(env.FILES, input.ownerId, input.conversation.id, [
      recentImage.id,
    ]);
    return image ? { ...input, attachments: [...(input.attachments ?? []), image] } : input;
  } catch {
    // Expired or removed files should not prevent a normal text turn.
    return input;
  }
}

async function createPrimaryStream(
  options: TurnStreamOptions,
  memory: Awaited<ReturnType<typeof prepareAgentMemory>> | undefined,
  workspace: Workspace | undefined,
  telemetry: ApiTelemetry | null,
): Promise<AsyncIterable<ChatEvent>> {
  const { env, input, model, modelName, signal, checkpoints } = options;
  const mcpTools = await createMcpService(env).tools();
  const allowedUrls = collectAllowedUrls(input);
  const tools: McpTools = {
    ...mcpTools,
    ...createDocumentTools(env, input),
    ...createResearchTools(env, input.ownerId, signal, allowedUrls),
    ...createWebSearchTools(env, signal, allowedUrls),
  };
  return streamMastraTurn({
    input: await includeRecentImage(env, input),
    model: checkpointModel(model, checkpoints, 'chat', undefined, modelProgress(checkpoints)),
    signal,
    tools,
    trace: agentTrace(telemetry, input.telemetryUserId, modelName),
    runtime: { memory, workspace, checkpoints, onToolResult: restoreSearchUrls(allowedUrls) },
  });
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
  const { env, input } = options;
  if (preference?.enabled && input.ownerId && input.telemetryUserId) {
    await captureConversation(env, {
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
  }
  await telemetry?.flush();
}

export async function* streamTurnEvents(options: TurnStreamOptions): AsyncGenerator<ChatEvent> {
  const { env, input, model } = options;
  const telemetry = input.telemetryUserId ? createApiTelemetry(env) : null;
  const startedAt = Date.now();
  const preference = await contentPreference(env.DB, input.ownerId);
  let visibleResponse = '';
  let completed = false;
  try {
    const memory = yield* prepareTurnMemory(env, input, model, options.signal);
    const workspace = createTurnWorkspace(env, input);
    const stream = await createPrimaryStream(options, memory, workspace, telemetry);
    options.signal.throwIfAborted();
    for await (const event of stream) {
      visibleResponse = appendVisibleResponse(visibleResponse, event);
      // Highlights are generated after the reply commits, through the
      // follow-up annotations stream, so they never hold the composer.
      yield event.type === 'done' ? { ...event, annotationsHandled: false } : event;
    }
    completed = true;
  } finally {
    const finishing = finishTurnStream(
      options,
      preference,
      telemetry,
      visibleResponse,
      startedAt,
      completed,
    );
    if (options.background) options.background(finishing);
    else await finishing;
  }
}
