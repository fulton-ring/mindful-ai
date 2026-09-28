import { WORKSPACE_TOOLS, Workspace } from '@mastra/core/workspace';
import { uiMessageText, type WaldenUIMessageChunk } from '@walden/contracts';
import { createCompactTools } from '../../agent/compact-tool';
import { createDocumentTools } from '../../agent/document-tool';
import { streamMastraTurn } from '../../agent/mastra-turn';
import { type MemoryLifecycleEvent, prepareAgentMemory } from '../../agent/memory/memory';
import { R2WorkspaceFilesystem } from '../../agent/r2-workspace';
import { agentTrace } from '../../agent/stream-events';
import { loadAttachments } from '../../chat/attachments/attachments';
import { messageAttachments } from '../../chat/messages';
import { isConversationLive } from '../../chat/turns/turn-store';
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
  /** Condenses the conversation's memory; the default fast model, not the persona's. */
  memoryModel: AgentModel;
  /** Aborts on cancellation or the turn deadline. */
  signal: AbortSignal;
  /** Runs work after the turn commits; telemetry must not delay the reply. */
  background?: (task: Promise<void>) => void;
};

function collectAllowedUrls(input: AgentTurnInput): Set<string> {
  const userText = [
    input.message,
    ...input.conversation.messages.filter((message) => message.role === 'user').map(uiMessageText),
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

async function* prepareTurnMemory(
  env: ServiceEnv,
  input: AgentTurnInput,
  model: AgentModel,
  signal: AbortSignal,
): AsyncGenerator<
  WaldenUIMessageChunk,
  Awaited<ReturnType<typeof prepareAgentMemory>> | undefined
> {
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

const FILES = WORKSPACE_TOOLS.FILESYSTEM;
/**
 * Workspace tools are named after the framework (`mastra_workspace_read_file`);
 * these plain names match the other tools and are what the reader sees.
 */
const WORKSPACE_TOOL_NAMES = {
  [FILES.READ_FILE]: 'readFile',
  [FILES.WRITE_FILE]: 'writeFile',
  [FILES.EDIT_FILE]: 'editFile',
  [FILES.LIST_FILES]: 'listFiles',
  [FILES.DELETE]: 'deleteFile',
  [FILES.FILE_STAT]: 'fileInfo',
  [FILES.MKDIR]: 'makeFolder',
  [FILES.GREP]: 'searchFiles',
  [FILES.AST_EDIT]: 'editCode',
};

export function createTurnWorkspace(env: ServiceEnv, input: AgentTurnInput): Workspace | undefined {
  if (!input.ownerId || !env.FILES) return undefined;
  return new Workspace({
    filesystem: new R2WorkspaceFilesystem(env.FILES, input.ownerId, input.conversation.id),
    tools: Object.fromEntries(
      Object.entries(WORKSPACE_TOOL_NAMES).map(([tool, name]) => [tool, { name }]),
    ),
  });
}

export async function includeRecentImage(
  env: ServiceEnv,
  input: AgentTurnInput,
): Promise<AgentTurnInput> {
  if (!env.FILES || !input.ownerId || input.attachments?.some(({ bytes }) => bytes)) return input;
  const recentImage = input.conversation.messages
    .flatMap(messageAttachments)
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
): Promise<AsyncIterable<WaldenUIMessageChunk>> {
  const { env, input, model, modelName, signal, memoryModel } = options;
  const mcpTools = await createMcpService(env).tools();
  const allowedUrls = collectAllowedUrls(input);
  const tools: McpTools = {
    ...mcpTools,
    ...createDocumentTools(env, input),
    ...createResearchTools(env, input.ownerId, signal, allowedUrls),
    ...createWebSearchTools(env, signal, allowedUrls),
    ...(memory && env.DB && input.ownerId
      ? createCompactTools({
          db: env.DB,
          ownerId: input.ownerId,
          conversation: input.conversation,
          model: memoryModel,
          signal,
        })
      : {}),
  };
  return streamMastraTurn({
    input: await includeRecentImage(env, input),
    model,
    signal,
    tools,
    trace: agentTrace(telemetry, input.telemetryUserId, modelName),
    runtime: { memory, workspace, onToolResult: restoreSearchUrls(allowedUrls) },
  });
}

function appendVisibleResponse(visibleResponse: string, chunk: WaldenUIMessageChunk): string {
  if (chunk.type === 'text-delta') return (visibleResponse + chunk.delta).slice(0, 24_000);
  if (chunk.type !== 'data-intervention' || chunk.data.kind !== 'learning_check') {
    return visibleResponse;
  }
  return (
    visibleResponse +
    '\n' +
    chunk.data.questions.map(({ question }) => question).join('\n')
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

export async function* streamTurnChunks(
  options: TurnStreamOptions,
): AsyncGenerator<WaldenUIMessageChunk> {
  const { env, input, memoryModel } = options;
  const telemetry = input.telemetryUserId ? createApiTelemetry(env) : null;
  const startedAt = Date.now();
  const preference = await contentPreference(env.DB, input.ownerId);
  let visibleResponse = '';
  let completed = false;
  try {
    const memory = yield* prepareTurnMemory(env, input, memoryModel, options.signal);
    const workspace = createTurnWorkspace(env, input);
    const stream = await createPrimaryStream(options, memory, workspace, telemetry);
    options.signal.throwIfAborted();
    // Highlights are generated after the reply commits, through the follow-up
    // annotations stream, so they never hold the composer.
    for await (const chunk of stream) {
      visibleResponse = appendVisibleResponse(visibleResponse, chunk);
      yield chunk;
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
