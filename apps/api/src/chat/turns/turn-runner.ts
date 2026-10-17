import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { AppDatabase } from '../../db/database';
import { claimNativeFinalization, type NativeExecutionContext } from '../../execution/native-agent';
import { captureChatFailure, captureTurnLifecycle } from '../../observability';
import { createAgentService, modelNameForPersona } from '../../services/agent/agent';
import { aiFailureCode, aiProviderErrorMessage } from '../../services/ai-errors/ai-errors';
import type { Bindings } from '../../types';
import { loadAttachments } from '../attachments/attachments';
import { loadConversation } from '../conversations/repository';
import { transientStatus } from '../messages';
import type { ChunkLog } from './chunk-log';
import { completeTurn, finishTurn, isTurnActive, type TurnInput, type TurnRow } from './turn-store';

export type Background = (task: Promise<void>) => void;
type Progress = { model: string; partialResponse: boolean; toolIds: Set<string> };
type Chunk = WaldenUIMessageChunk;

/** Abort reason for Stop; any other reason is a failure. */
export const STOPPED = 'Turn stopped';
const ENDED: Chunk = { type: 'error', errorText: 'Turn has ended. Reload the conversation.' };
const INCOMPLETE = 'The response could not finish. Please try again.';

/** Deletion or expiry of the conversation or branch ends the turn within a couple of seconds. */
function watchActive(db: AppDatabase, row: TurnRow, controller: AbortController) {
  let checking = false;
  return setInterval(() => {
    if (checking) return;
    checking = true;
    void isTurnActive(db, row.id, row.execution_generation)
      .then((active) => {
        if (!active) controller.abort('Turn is no longer active');
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  }, 2_000);
}

async function loadInput(env: Bindings, row: TurnRow): Promise<TurnInput> {
  const input = JSON.parse(row.input_json ?? '{}') as TurnInput;
  if (!input.attachments?.length || !env.FILES) return input;
  return {
    ...input,
    attachments: await loadAttachments(
      env.FILES,
      row.owner_id,
      row.conversation_id,
      input.attachments.map(({ id }) => id),
    ),
  };
}

function trackProgress(progress: Progress, chunk: Chunk) {
  if (chunk.type === 'text-delta') progress.partialResponse = true;
  if (chunk.type === 'tool-input-available') progress.toolIds.add(chunk.toolCallId);
}

/** The stream's opening chunks: the assistant message id is the turn id. */
export function openingChunks(row: TurnRow, input: TurnInput, model: string): Chunk[] {
  return [
    {
      type: 'start',
      messageId: row.id,
      messageMetadata: {
        createdAt: new Date().toISOString(),
        personaName: input.persona.name,
        model,
      },
    },
    {
      type: 'data-turn',
      transient: true,
      data: {
        conversationId: row.conversation_id,
        branchId: row.branch_id,
        ...(row.user_message_id ? { userMessageId: row.user_message_id } : {}),
      },
    },
    transientStatus('Thinking…'),
  ];
}

async function generateTurn(
  env: Bindings,
  row: TurnRow,
  signal: AbortSignal,
  log: ChunkLog,
  progress: Progress,
  background: Background,
  execution?: NativeExecutionContext,
) {
  const input = await loadInput(env, row);
  progress.model = modelNameForPersona(env, input.persona);
  const agent = createAgentService(env, background, execution);
  if (!execution) await log.append(...openingChunks(row, input, progress.model));
  const stream = await agent.streamTurn(input, signal);
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await iterator.next();
      if (next.done) break;
      signal.throwIfAborted();
      trackProgress(progress, next.value);
      await log.append(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return input;
}

/**
 * Brings conversation memory up to date with the saved reply after readers have
 * it, so a summary is written now rather than making the next reply wait.
 */
async function updateMemoryAfterReply(
  env: Bindings,
  row: TurnRow,
  input: TurnInput,
  background: Background,
  signal: AbortSignal,
) {
  try {
    const conversation = await loadConversation(env.DB, row.owner_id, row.conversation_id, {
      branchId: row.branch_id,
    });
    await createAgentService(env, background).updateMemory({ ...input, conversation }, signal);
  } catch {
    console.warn('Memory update after reply failed', { turnId: row.id });
  }
}

function failureMessage(error: unknown) {
  return (
    aiProviderErrorMessage(error) ??
    (error instanceof Error && error.message.startsWith('The response reached its output limit.')
      ? error.message
      : INCOMPLETE)
  );
}

async function recordFailure(
  env: Bindings,
  row: TurnRow,
  log: ChunkLog,
  error: unknown,
  progress: Progress,
  background: Background,
) {
  const code = aiFailureCode(error);
  const end = await finishTurn(env.DB, row, log.chunks, 'failed', failureMessage(error), code);
  background(
    captureChatFailure(env, {
      userId: row.owner_id,
      conversationId: row.conversation_id,
      turnId: row.id,
      code,
      model: progress.model,
      hadPartialResponse: progress.partialResponse,
      toolCount: progress.toolIds.size,
    }),
  );
  return end;
}

async function endTurn(
  env: Bindings,
  row: TurnRow,
  log: ChunkLog,
  signal: AbortSignal,
  error: unknown,
  progress: Progress,
  background: Background,
) {
  const cancelled =
    signal.reason === STOPPED ||
    Boolean(
      await env.DB.prepare('SELECT 1 FROM turn_cancellations WHERE owner_id=? AND request_id=?')
        .bind(row.owner_id, row.request_id)
        .first(),
    );
  if (cancelled)
    return finishTurn(env.DB, row, log.chunks, 'cancelled', 'Turn cancelled', 'cancelled');
  return recordFailure(env, row, log, error, progress, background);
}

/**
 * Runs an admitted turn to its end: streams the agent's chunks into the log,
 * then commits the reply to D1, or keeps what streamed as an interrupted reply.
 * Resolves with the turn's final status.
 */
export async function runTurn(
  env: Bindings,
  row: TurnRow,
  log: ChunkLog,
  controller: AbortController,
  background: Background,
  execution?: NativeExecutionContext,
): Promise<string> {
  background(
    captureTurnLifecycle(env, 'chat_turn_started', {
      userId: row.owner_id,
      conversationId: row.conversation_id,
      turnId: row.id,
      requestId: row.request_id,
      attempt: 1,
      // Time from turn reservation to the turn starting to run.
      queueMs: Date.now() - Date.parse(row.created_at),
    }),
  );
  const watcher = watchActive(env.DB, row, controller);
  const progress: Progress = { model: 'unknown', partialResponse: false, toolIds: new Set() };
  let end: Chunk[] | null;
  let input: TurnInput | undefined;
  let completed = false;
  try {
    input = await generateTurn(env, row, controller.signal, log, progress, background, execution);
    // An aborted agent stream can end without throwing; what streamed is not a whole reply.
    controller.signal.throwIfAborted();
    if (execution?.draining) throw new Error('Turn host is draining');
    end = await completeTurn(env.DB, row, log.chunks);
    completed = end !== null;
    end ??= await finishTurn(env.DB, row, log.chunks, 'failed', INCOMPLETE);
  } catch (error) {
    if (execution?.draining || isNativeOwnerActive(error)) throw error;
    // A reconstructed contender inherits the current row generation, not its ownership.
    // Claim atomically before an early setup failure can write a terminal result.
    if (execution && !execution.claimed) await claimNativeFinalization(execution);
    end = await endTurn(env, row, log, controller.signal, error, progress, background).catch(
      () => null,
    );
  } finally {
    clearInterval(watcher);
    await execution?.releaseOwnership?.();
  }
  await log.append(...(end ?? [ENDED]));
  log.end();
  if (completed && input)
    await updateMemoryAfterReply(env, row, input, background, controller.signal);
  return terminalStatus(env, row, background);
}

/** Seals a turn whose run was lost (a deploy or restart) with what it had streamed. */
export async function sealInterruptedTurn(
  env: Bindings,
  row: TurnRow,
  log: ChunkLog,
  background: Background,
  stopped = false,
) {
  const end = await finishTurn(
    env.DB,
    row,
    log.chunks,
    stopped ? 'cancelled' : 'failed',
    stopped ? 'Turn cancelled' : 'The response was interrupted. Please try again.',
    stopped ? 'cancelled' : 'internal_error',
  );
  if (!log.isEnded) {
    await log.append(...(end ?? [ENDED]));
    log.end();
  }
  return terminalStatus(env, row, background);
}

async function terminalStatus(env: Bindings, row: TurnRow, background: Background) {
  const latest = await env.DB.prepare('SELECT status FROM turns WHERE id=?')
    .bind(row.id)
    .first<{ status: string }>();
  const status = latest?.status ?? 'deleted';
  background(
    captureTurnLifecycle(env, 'chat_turn_terminal', {
      userId: row.owner_id,
      conversationId: row.conversation_id,
      turnId: row.id,
      requestId: row.request_id,
      attempt: 1,
      status,
    }),
  );
  return status;
}

function isNativeOwnerActive(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    const current = error as { id?: string; cause?: unknown };
    if (
      current.id === 'DURABLE_AGENT_RUN_ACTIVE' ||
      current.id === 'DURABLE_AGENT_RECOVER_RUN_ACTIVE_LOCALLY'
    )
      return true;
    error = current.cause;
  }
  return false;
}
