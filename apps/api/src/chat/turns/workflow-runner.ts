import type { WorkflowStep } from 'cloudflare:workers';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { AgentCheckpoints, ChunkPreview } from '../../agent/checkpoints';
import { first } from '../../db/client';
import { captureChatFailure, captureTurnLifecycle } from '../../observability';
import { createAgentService, modelNameForPersona } from '../../services/agent/agent';
import { aiFailureCode, aiProviderErrorMessage } from '../../services/ai-errors/ai-errors';
import type { Bindings } from '../../types';
import { loadAttachments } from '../attachments/attachments';
import { transientStatus } from '../messages';
import {
  appendTurnChunks,
  beginTurnExecution,
  completeTurn,
  type DurableTurnInput,
  type DurableTurnRow,
  finishTurn,
  restartTurnChunks,
  TURN_BUDGET_MS,
} from './durable-store';

type Guard = () => Promise<void>;
type Background = (task: Promise<void>) => void;
type Progress = { model: string; partialResponse: boolean; toolIds: Set<string> };
type Chunk = WaldenUIMessageChunk;
type Publisher = {
  emit(chunk: Chunk): Promise<void>;
  flush(): Promise<void>;
  mark(): number;
  rewind(mark: number): Promise<void>;
  /** Set once the model preview writes; the agent's own text chunks are then duplicates. */
  previewed: boolean;
};
/** Chunk types the checkpointed model preview already wrote live. */
const PREVIEWED_TYPES = new Set<Chunk['type']>([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'start-step',
  'finish-step',
]);

function activeGuard(
  env: Bindings,
  row: DurableTurnRow,
  epoch: number,
  controller: AbortController,
): Guard {
  const deadlineAt = Date.parse(row.created_at) + TURN_BUDGET_MS;
  return async () => {
    if (Date.now() >= deadlineAt) controller.abort('Turn execution budget exceeded');
    const now = new Date().toISOString();
    const active = await first(
      env.DB.prepare(`SELECT t.id FROM turns t
      JOIN conversations c ON c.id=t.conversation_id JOIN conversation_branches b ON b.id=t.branch_id
      WHERE t.id=? AND t.status='streaming' AND t.execution_epoch=?
      AND c.status='active' AND b.status='active' AND c.expires_at>?`).bind(row.id, epoch, now),
    );
    if (!active) controller.abort('Turn stopped');
    if (controller.signal.aborted) throw new Error('Turn stopped or execution budget exceeded');
  };
}

function watchCancellation(assertActive: Guard, controller: AbortController) {
  let checking = false;
  return setInterval(() => {
    if (checking) return;
    checking = true;
    void assertActive()
      .catch(() => controller.abort('Turn stopped'))
      .finally(() => {
        checking = false;
      });
  }, 1000);
}

const isDelta = (chunk: Chunk): chunk is Extract<Chunk, { delta: string }> =>
  chunk.type === 'text-delta' || chunk.type === 'reasoning-delta';

/**
 * Appends the epoch's chunks in small batches. Consecutive deltas of one part
 * are merged; anything else is written at once. `written` mirrors the stored
 * stream so a retried model call can rewind it.
 */
function chunkPublisher(env: Bindings, row: DurableTurnRow, epoch: number): Publisher {
  const written: Chunk[] = [];
  let pending: Chunk[] = [];
  let characters = 0;
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    characters = 0;
    await appendTurnChunks(env.DB, row.id, epoch, batch);
  };
  return {
    previewed: false,
    flush,
    mark: () => written.length,
    async emit(chunk) {
      const last = pending.at(-1);
      if (isDelta(chunk) && last?.type === chunk.type && last.id === chunk.id)
        last.delta += chunk.delta;
      else {
        const copy = { ...chunk };
        pending.push(copy);
        written.push(copy);
      }
      if (isDelta(chunk)) characters += chunk.delta.length;
      if (characters >= 1024 || !isDelta(chunk)) await flush();
    },
    async rewind(mark) {
      pending = [];
      characters = 0;
      written.length = mark;
      await restartTurnChunks(env.DB, row, epoch, written);
    },
  };
}

async function loadInput(env: Bindings, row: DurableTurnRow): Promise<DurableTurnInput> {
  const input = JSON.parse(row.input_json ?? '{}') as DurableTurnInput;
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

function chunkPreview(publish: Publisher, signal: AbortSignal): ChunkPreview {
  return {
    mark: () => publish.mark(),
    async write(chunks) {
      signal.throwIfAborted();
      publish.previewed = true;
      for (const chunk of chunks) await publish.emit(chunk);
      await publish.flush();
    },
    rewind: (mark) => publish.rewind(mark),
  };
}

function checkpoints(
  step: WorkflowStep,
  signal: AbortSignal,
  assertActive: Guard,
  publish: Publisher,
): AgentCheckpoints {
  return {
    preview: chunkPreview(publish, signal),
    do: async <T>(name: string, callback: () => Promise<T>, options?: { retries?: number }) => {
      await assertActive();
      return step.do(
        name,
        {
          retries: { limit: options?.retries ?? 2, delay: '2 seconds', backoff: 'exponential' },
          timeout: '15 minutes',
        },
        async () => {
          await assertActive();
          const result = await callback();
          await assertActive();
          return result as never;
        },
      ) as Promise<T>;
    },
  };
}

function trackProgress(progress: Progress, chunk: Chunk) {
  if (chunk.type === 'text-delta') progress.partialResponse = true;
  if (chunk.type === 'tool-input-available') progress.toolIds.add(chunk.toolCallId);
}

/** The epoch's opening chunks: the assistant message id is the turn id. */
function openingChunks(row: DurableTurnRow, input: DurableTurnInput, model: string): Chunk[] {
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
  row: DurableTurnRow,
  step: WorkflowStep,
  controller: AbortController,
  assertActive: Guard,
  publish: Publisher,
  progress: Progress,
  background: Background,
) {
  const input = await loadInput(env, row);
  progress.model = modelNameForPersona(env, input.persona);
  const agent = createAgentService(env, background);
  const turnCheckpoints = checkpoints(step, controller.signal, assertActive, publish);
  for (const chunk of openingChunks(row, input, progress.model)) await publish.emit(chunk);
  // The cancellation watcher checks D1 once a second and aborts the signal;
  // chunk writes are fenced by epoch and status, so no per-chunk query.
  for await (const chunk of await agent.streamTurn(input, turnCheckpoints, controller.signal)) {
    controller.signal.throwIfAborted();
    trackProgress(progress, chunk);
    if (publish.previewed && PREVIEWED_TYPES.has(chunk.type)) continue;
    await publish.emit(chunk);
  }
  await publish.flush();
}

async function recordFailure(
  env: Bindings,
  row: DurableTurnRow,
  step: WorkflowStep,
  epoch: number,
  error: unknown,
  progress: Progress,
  background: Background,
) {
  const code = aiFailureCode(error);
  const message =
    aiProviderErrorMessage(error) ??
    (error instanceof Error && error.message.startsWith('The response reached its output limit.')
      ? error.message
      : 'The response could not finish. Please try again.');
  await step.do('record-failure', async () => {
    await finishTurn(env.DB, row.id, row.owner_id, 'failed', message, epoch, code);
    return true;
  });
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
}

async function terminalResult(
  env: Bindings,
  row: DurableTurnRow,
  epoch: number,
  background: Background,
) {
  const latest = await first<{ status: string }>(
    env.DB.prepare('SELECT status FROM turns WHERE id=?').bind(row.id),
  );
  const status = latest?.status ?? 'deleted';
  background(
    captureTurnLifecycle(env, 'chat_turn_terminal', {
      userId: row.owner_id,
      conversationId: row.conversation_id,
      turnId: row.id,
      requestId: row.request_id,
      attempt: epoch,
      status,
    }),
  );
  return { turnId: row.id, status };
}

export async function runChatTurn(
  env: Bindings,
  turnId: string,
  step: WorkflowStep,
  background: Background = (task) => void task.catch(() => undefined),
) {
  const row = await first<DurableTurnRow>(
    env.DB.prepare('SELECT * FROM turns WHERE id=?').bind(turnId),
  );
  if (!row || row.status !== 'streaming' || !row.input_json)
    return { turnId, status: row?.status ?? 'deleted' };
  const epoch = await beginTurnExecution(env.DB, row);
  if (epoch === null) return { turnId, status: 'stopped' };
  background(
    captureTurnLifecycle(env, epoch > 1 ? 'chat_turn_recovered' : 'chat_turn_started', {
      userId: row.owner_id,
      conversationId: row.conversation_id,
      turnId,
      requestId: row.request_id,
      attempt: epoch,
      // Time from turn reservation to the Workflow starting; separates
      // admission cost from Workflow scheduling in latency investigations.
      queueMs: Date.now() - Date.parse(row.created_at),
    }),
  );
  const controller = new AbortController();
  const assertActive = activeGuard(env, row, epoch, controller);
  const cancellation = watchCancellation(assertActive, controller);
  const publish = chunkPublisher(env, row, epoch);
  const progress: Progress = { model: 'unknown', partialResponse: false, toolIds: new Set() };
  try {
    await generateTurn(env, row, step, controller, assertActive, publish, progress, background);
    const committed = await step.do('commit-turn', async () => {
      await assertActive();
      return completeTurn(env.DB, turnId, epoch);
    });
    if (!committed)
      await finishTurn(
        env.DB,
        turnId,
        row.owner_id,
        'failed',
        'The response could not finish. Please try again.',
        epoch,
      );
    return terminalResult(env, row, epoch, background);
  } catch (error) {
    await publish.flush();
    await recordFailure(env, row, step, epoch, error, progress, background);
    return terminalResult(env, row, epoch, background);
  } finally {
    clearInterval(cancellation);
  }
}
