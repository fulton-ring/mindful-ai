import type { WorkflowStep } from 'cloudflare:workers';
import type { ChatEvent } from '@walden/contracts';
import { first } from '../../db/client';
import { captureChatFailure, captureTurnLifecycle } from '../../observability';
import { createAgentService, modelNameForPersona } from '../../services/agent/agent';
import { aiFailureCode, aiProviderErrorMessage } from '../../services/ai-errors/ai-errors';
import type { Bindings } from '../../types';
import { loadAttachments } from '../attachments/attachments';
import {
  appendTurnEvents,
  beginTurnExecution,
  completeTurn,
  type DurableTurnInput,
  type DurableTurnRow,
  finishTurn,
  TURN_BUDGET_MS,
} from './durable-store';

type Guard = () => Promise<void>;
type Progress = { model: string; partialResponse: boolean; toolIds: Set<string> };
type Publisher = { emit(event: ChatEvent): Promise<void>; flush(): Promise<void> };

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

function eventPublisher(env: Bindings, turnId: string, epoch: number): Publisher {
  let pending: ChatEvent[] = [];
  let characters = 0;
  const flush = async () => {
    if (!pending.length) return;
    await appendTurnEvents(env.DB, turnId, epoch, pending);
    pending = [];
    characters = 0;
  };
  return {
    flush,
    async emit(item) {
      const last = pending.at(-1);
      if ((item.type === 'text' || item.type === 'reasoning') && last?.type === item.type)
        last.text += item.text;
      else pending.push(item);
      if (item.type === 'text' || item.type === 'reasoning') characters += item.text.length;
      if (characters >= 1024 || (item.type !== 'text' && item.type !== 'reasoning')) await flush();
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

function checkpoints(
  step: WorkflowStep,
  assertActive: Guard,
  publish: Publisher,
  preview: { used: boolean },
) {
  return {
    publish: async (event: ChatEvent) => {
      await assertActive();
      preview.used = true;
      await publish.emit(event);
    },
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

function trackProgress(progress: Progress, item: ChatEvent) {
  if (item.type === 'text') progress.partialResponse = true;
  if (item.type === 'tool') progress.toolIds.add(item.tool.id);
}

async function generateTurn(
  env: Bindings,
  row: DurableTurnRow,
  step: WorkflowStep,
  controller: AbortController,
  assertActive: Guard,
  publish: Publisher,
  progress: Progress,
) {
  const input = await loadInput(env, row);
  progress.model = modelNameForPersona(env, input.persona);
  const preview = { used: false };
  const agent = createAgentService(env);
  const turnCheckpoints = checkpoints(step, assertActive, publish, preview);
  await publish.emit({ type: 'status', text: 'Thinking…' });
  let done: Extract<ChatEvent, { type: 'done' }> | undefined;
  let intervention: Extract<ChatEvent, { type: 'intervention' }>['intervention'] | undefined;
  for await (const item of await agent.streamTurn(input, turnCheckpoints, controller.signal)) {
    await assertActive();
    if (preview.used && (item.type === 'text' || item.type === 'reasoning')) continue;
    trackProgress(progress, item);
    if (item.type === 'done') done = item;
    else {
      if (item.type === 'intervention') intervention = item.intervention;
      if (item.type === 'error') throw new Error(item.message);
      await publish.emit(item);
    }
  }
  await publish.flush();
  if (!done) throw new Error('The model did not finish its response.');
  return { done, intervention };
}

async function recordFailure(
  env: Bindings,
  row: DurableTurnRow,
  step: WorkflowStep,
  epoch: number,
  error: unknown,
  progress: Progress,
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
  await captureChatFailure(env, {
    userId: row.owner_id,
    conversationId: row.conversation_id,
    turnId: row.id,
    code,
    model: progress.model,
    hadPartialResponse: progress.partialResponse,
    toolCount: progress.toolIds.size,
  });
}

async function terminalResult(env: Bindings, row: DurableTurnRow, epoch: number) {
  const latest = await first<{ status: string }>(
    env.DB.prepare('SELECT status FROM turns WHERE id=?').bind(row.id),
  );
  const status = latest?.status ?? 'deleted';
  await captureTurnLifecycle(env, 'chat_turn_terminal', {
    userId: row.owner_id,
    conversationId: row.conversation_id,
    turnId: row.id,
    requestId: row.request_id,
    attempt: epoch,
    status,
  });
  return { turnId: row.id, status };
}

export async function runChatTurn(env: Bindings, turnId: string, step: WorkflowStep) {
  const row = await first<DurableTurnRow>(
    env.DB.prepare('SELECT * FROM turns WHERE id=?').bind(turnId),
  );
  if (!row || row.status !== 'streaming' || !row.input_json)
    return { turnId, status: row?.status ?? 'deleted' };
  const epoch = await beginTurnExecution(env.DB, turnId);
  if (epoch === null) return { turnId, status: 'stopped' };
  await captureTurnLifecycle(env, epoch > 1 ? 'chat_turn_recovered' : 'chat_turn_started', {
    userId: row.owner_id,
    conversationId: row.conversation_id,
    turnId,
    requestId: row.request_id,
    attempt: epoch,
  });
  const controller = new AbortController();
  const assertActive = activeGuard(env, row, epoch, controller);
  const cancellation = watchCancellation(assertActive, controller);
  const publish = eventPublisher(env, turnId, epoch);
  const progress: Progress = { model: 'unknown', partialResponse: false, toolIds: new Set() };
  try {
    const { done, intervention } = await generateTurn(
      env,
      row,
      step,
      controller,
      assertActive,
      publish,
      progress,
    );
    const committed = await step.do('commit-turn', async () => {
      await assertActive();
      return completeTurn(env.DB, turnId, epoch, done, intervention);
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
    return terminalResult(env, row, epoch);
  } catch (error) {
    await publish.flush();
    await recordFailure(env, row, step, epoch, error, progress);
    return terminalResult(env, row, epoch);
  } finally {
    clearInterval(cancellation);
  }
}
