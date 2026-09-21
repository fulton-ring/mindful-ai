import {
  type ChatEvent,
  type Message,
  type MessageSource,
  type ToolActivity,
} from '@walden/contracts';
import { first } from '../db/client';
import { newId, nowIso } from '../http';
import { createAgentService } from '../services/agent';
import { aiProviderErrorMessage } from '../services/ai-errors';
import type { Bindings } from '../types';
import { registerActiveTurn, removeActiveTurn } from './active-turns';
import { agentHighlightStatements } from './agent-highlights';
import type { PreparedTurn, TurnRuntime } from './turn-lifecycle';
import { createDurableStream, sse } from './turn-support';

export type TurnStreamRuntime = TurnRuntime & {
  env: Bindings;
  authSubject: string;
  requestSignal: AbortSignal;
  executionCtx: { waitUntil(task: Promise<unknown>): void };
};

type StreamState = {
  controller: AbortController;
  assistantText: string;
  assistantReasoning: string;
  doneEvent?: Extract<ChatEvent, { type: 'done' }>;
  annotations: Extract<ChatEvent, { type: 'annotation' }>['annotation'][];
  tools: Map<string, ToolActivity>;
  sources: Map<string, MessageSource>;
  contextCompacted: boolean;
  inputTokens: number;
  outputTokens: number;
  emitted: boolean;
};

type Emit = (event: ChatEvent) => void;

function createStreamState(controller: AbortController): StreamState {
  return {
    controller,
    assistantText: '',
    assistantReasoning: '',
    annotations: [],
    tools: new Map(),
    sources: new Map(),
    contextCompacted: false,
    inputTokens: 0,
    outputTokens: 0,
    emitted: false,
  };
}

function createEmitter(
  output: ReadableStreamDefaultController<Uint8Array>,
  controller: AbortController,
  state: StreamState,
): Emit {
  return (event) => {
    try {
      output.enqueue(sse(event));
      state.emitted = true;
    } catch {
      controller.abort('client disconnected');
    }
  };
}

async function ensureStreaming(runtime: TurnRuntime, turnId: string, controller: AbortController) {
  const state = await first<{ status: string }>(
    runtime.db
      .prepare('SELECT status FROM turns WHERE id=? AND owner_id=?')
      .bind(turnId, runtime.ownerId),
  );
  if (state?.status === 'streaming') return;
  controller.abort('cancelled or expired');
  throw new Error('Turn cancelled');
}

function collectEvent(state: StreamState, event: ChatEvent) {
  if (event.type === 'text') state.assistantText += event.text;
  if (event.type === 'reasoning') state.assistantReasoning += event.text;
  if (event.type === 'done') state.doneEvent = event;
  if (event.type === 'annotation') state.annotations.push(event.annotation);
  if (event.type === 'tool') state.tools.set(event.tool.id, event.tool);
  if (event.type === 'source') state.sources.set(event.source.url, event.source);
  if (event.type === 'context-compacted') state.contextCompacted = true;
  if (event.type === 'usage') {
    state.inputTokens = event.usage.inputTokens;
    state.outputTokens = event.usage.outputTokens;
  }
}

async function persistIntervention(
  runtime: TurnRuntime,
  turn: PreparedTurn,
  intervention: Extract<ChatEvent, { type: 'intervention' }>['intervention'],
) {
  await runtime.db
    .prepare(
      "UPDATE interventions SET status='superseded' WHERE branch_id=? AND owner_id=? AND status='pending'",
    )
    .bind(turn.branchId, runtime.ownerId)
    .run();
  await runtime.db
    .prepare(
      "INSERT INTO interventions (id,conversation_id,turn_id,owner_id,kind,payload_json,status,created_at,branch_id) VALUES (?,?,?,?,?,?,'pending',?,?)",
    )
    .bind(
      intervention.id,
      turn.conversation.id,
      turn.turnId,
      runtime.ownerId,
      intervention.kind,
      JSON.stringify(intervention),
      nowIso(),
      turn.branchId,
    )
    .run();
}

async function consumeAgentEvents(
  runtime: TurnStreamRuntime,
  turn: PreparedTurn,
  agent: ReturnType<typeof createAgentService>,
  controller: AbortController,
  state: StreamState,
  emit: Emit,
) {
  if (controller.signal.aborted) throw new Error('Turn cancelled');
  const events = await agent.streamTurn(
    {
      ownerId: runtime.ownerId,
      telemetryUserId: runtime.authSubject,
      turnId: turn.turnId,
      requestId: turn.request.requestId,
      conversation: turn.conversation,
      note: turn.note,
      persona: turn.persona,
      message: turn.requestMessage,
      action: turn.request.action,
      pendingIntervention: turn.pendingIntervention,
    },
    controller.signal,
  );
  for await (const event of events) {
    await ensureStreaming(runtime, turn.turnId, controller);
    collectEvent(state, event);
    if (event.type === 'intervention') await persistIntervention(runtime, turn, event.intervention);
    if (event.type !== 'done') emit(event);
  }
}

function generatedMessage(state: StreamState): Message {
  return (
    state.doneEvent?.message ?? {
      id: newId(),
      role: 'assistant',
      content: state.assistantText,
      ...(state.assistantReasoning ? { reasoning: state.assistantReasoning } : {}),
      createdAt: nowIso(),
    }
  );
}

function completionMessageStatement(
  runtime: TurnRuntime,
  turn: PreparedTurn,
  state: StreamState,
  message: Message,
) {
  const activityJson = JSON.stringify({
    tools: message.tools ?? [...state.tools.values()],
    sources: message.sources ?? [...state.sources.values()],
    contextCompacted: message.contextCompacted ?? state.contextCompacted,
    ...(message.learningCheck ? { learningCheck: message.learningCheck } : {}),
  });
  return runtime.db
    .prepare(
      `INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,reasoning,activity_json,incomplete,sequence,created_at,parent_message_id,origin_branch_id,persona_name)
       SELECT ?,?,?,?,'assistant',?,?,?,0,(SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?),?,?,?,? WHERE EXISTS (
         SELECT 1 FROM turns t JOIN conversation_branches b ON b.id=t.branch_id AND b.owner_id=t.owner_id
         WHERE t.id=? AND t.owner_id=? AND t.status='streaming' AND b.id=? AND b.status='active' AND b.expires_at>?
       )`,
    )
    .bind(
      message.id,
      turn.conversation.id,
      turn.turnId,
      runtime.ownerId,
      message.content,
      message.reasoning ?? null,
      activityJson,
      turn.conversation.id,
      message.createdAt,
      turn.userMessageId,
      turn.branchId,
      turn.persona.name,
      turn.turnId,
      runtime.ownerId,
      turn.branchId,
      nowIso(),
    );
}

function completionStatements(
  runtime: TurnRuntime,
  turn: PreparedTurn,
  state: StreamState,
  message: Message,
) {
  return [
    completionMessageStatement(runtime, turn, state, message),
    runtime.db
      .prepare(
        "UPDATE turns SET status='completed',completed_at=? WHERE id=? AND owner_id=? AND branch_id=? AND status='streaming' AND EXISTS (SELECT 1 FROM messages WHERE id=? AND turn_id=? AND owner_id=?)",
      )
      .bind(
        nowIso(),
        turn.turnId,
        runtime.ownerId,
        turn.branchId,
        message.id,
        turn.turnId,
        runtime.ownerId,
      ),
    runtime.db
      .prepare(
        "UPDATE conversation_branches SET head_message_id=? WHERE id=? AND owner_id=? AND status='active' AND EXISTS (SELECT 1 FROM turns WHERE id=? AND owner_id=? AND status='completed')",
      )
      .bind(message.id, turn.branchId, runtime.ownerId, turn.turnId, runtime.ownerId),
    runtime.db
      .prepare('UPDATE turns SET input_tokens=?,output_tokens=? WHERE id=? AND owner_id=?')
      .bind(state.inputTokens, state.outputTokens, turn.turnId, runtime.ownerId),
    runtime.db
      .prepare(
        'UPDATE usage_periods SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE owner_id=?',
      )
      .bind(state.inputTokens, state.outputTokens, runtime.ownerId),
    ...agentHighlightStatements(runtime.db, {
      messageId: message.id,
      ownerId: runtime.ownerId,
      content: message.content,
      annotations: message.annotations ?? state.annotations,
      updatedAt: message.createdAt,
    }),
  ];
}

async function persistCompletion(
  runtime: TurnRuntime,
  turn: PreparedTurn,
  state: StreamState,
  message: Message,
) {
  const liveConversation = await first<{ id: string }>(
    runtime.db
      .prepare(
        "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND expires_at>?",
      )
      .bind(turn.conversation.id, runtime.ownerId, nowIso()),
  );
  if (!liveConversation) throw new Error('Conversation expired');
  if (state.controller.signal.aborted) throw new Error('Turn cancelled');
  const result = await runtime.db.batch(completionStatements(runtime, turn, state, message));
  if (
    result[0]?.meta.changes !== 1 ||
    result[1]?.meta.changes !== 1 ||
    result[2]?.meta.changes !== 1
  )
    throw new Error('Response changed during regeneration');
}

function stoppedActivity(state: StreamState) {
  return {
    tools: [...state.tools.values()].map((tool) =>
      tool.state === 'running' ? { ...tool, state: 'error' as const, summary: 'Stopped' } : tool,
    ),
    sources: [...state.sources.values()],
    contextCompacted: state.contextCompacted,
  };
}

function partialMessage(state: StreamState, activity: ReturnType<typeof stoppedActivity>): Message {
  return {
    id: newId(),
    role: 'assistant',
    content: state.assistantText,
    ...(state.assistantReasoning ? { reasoning: state.assistantReasoning } : {}),
    ...(activity.tools.length ? { tools: activity.tools } : {}),
    ...(activity.sources.length ? { sources: activity.sources } : {}),
    ...(activity.contextCompacted ? { contextCompacted: true } : {}),
    incomplete: true,
    createdAt: nowIso(),
  };
}

function partialMessageStatements(
  runtime: TurnRuntime,
  turn: PreparedTurn,
  partial: Message,
  activity: ReturnType<typeof stoppedActivity>,
) {
  if (turn.branchFork) return [];
  return [
    runtime.db
      .prepare(
        "INSERT OR IGNORE INTO messages (id,conversation_id,turn_id,owner_id,role,content,reasoning,activity_json,incomplete,sequence,created_at,parent_message_id,origin_branch_id) VALUES (?,?,?,?, 'assistant',?,?,?,1,(SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?),?,?,?)",
      )
      .bind(
        partial.id,
        turn.conversation.id,
        turn.turnId,
        runtime.ownerId,
        partial.content,
        partial.reasoning || null,
        JSON.stringify(activity),
        turn.conversation.id,
        partial.createdAt,
        turn.userMessageId,
        turn.branchId,
      ),
    runtime.db
      .prepare(
        "UPDATE conversation_branches SET head_message_id=? WHERE id=? AND owner_id=? AND status='active' AND EXISTS (SELECT 1 FROM messages WHERE id=? AND owner_id=? AND incomplete=1)",
      )
      .bind(partial.id, turn.branchId, runtime.ownerId, partial.id, runtime.ownerId),
  ];
}

function failureStatusStatements(runtime: TurnRuntime, turn: PreparedTurn, cancelled: boolean) {
  const { db, ownerId } = runtime;
  return [
    ...(turn.branchFork
      ? [
          db
            .prepare(
              "UPDATE conversation_branches SET status='expired',head_message_id=? WHERE id=? AND owner_id=? AND is_default=0",
            )
            .bind(turn.userMessageId, turn.branchId, ownerId),
        ]
      : []),
    db
      .prepare(
        "UPDATE turns SET status=?,completed_at=? WHERE id=? AND owner_id=? AND status='streaming'",
      )
      .bind(cancelled ? 'cancelled' : 'failed', nowIso(), turn.turnId, ownerId),
    ...(cancelled
      ? [
          db
            .prepare(
              "UPDATE turns SET status='cancelled',completed_at=? WHERE id=? AND owner_id=? AND status='completed'",
            )
            .bind(nowIso(), turn.turnId, ownerId),
          db
            .prepare(
              "UPDATE messages SET incomplete=1 WHERE turn_id=? AND owner_id=? AND role='assistant'",
            )
            .bind(turn.turnId, ownerId),
        ]
      : []),
  ];
}

function failureStatements(
  runtime: TurnRuntime,
  turn: PreparedTurn,
  partial: Message,
  activity: ReturnType<typeof stoppedActivity>,
  cancelled: boolean,
) {
  return [
    ...partialMessageStatements(runtime, turn, partial, activity),
    ...failureStatusStatements(runtime, turn, cancelled),
  ];
}

async function persistFailure(
  runtime: TurnStreamRuntime,
  turn: PreparedTurn,
  state: StreamState,
  error: unknown,
  emit: Emit,
) {
  const cancelled = state.controller.signal.aborted;
  const activity = stoppedActivity(state);
  const partial = partialMessage(state, activity);
  const exists = await first<{ id: string }>(
    runtime.db
      .prepare(
        "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND expires_at>?",
      )
      .bind(turn.conversation.id, runtime.ownerId, nowIso()),
  );
  let partialPersisted = false;
  if (exists) {
    const results = await runtime.db.batch(
      failureStatements(runtime, turn, partial, activity, cancelled),
    );
    partialPersisted = !turn.branchFork && results[0]?.meta.changes === 1;
  }
  if (!state.emitted)
    await runtime.db
      .prepare('UPDATE usage_periods SET used=MAX(0,used-1) WHERE owner_id=?')
      .bind(runtime.ownerId)
      .run();
  emit({
    type: 'error',
    message: cancelled
      ? 'Turn cancelled'
      : (aiProviderErrorMessage(error) ?? (error instanceof Error ? error.message : 'Turn failed')),
    ...(!cancelled && partialPersisted ? { partialMessage: partial } : {}),
  });
}

async function runTurnStream(
  runtime: TurnStreamRuntime,
  turn: PreparedTurn,
  controller: AbortController,
  output: ReadableStreamDefaultController<Uint8Array>,
  agent: ReturnType<typeof createAgentService>,
  cancelFromRequest: () => void,
) {
  const state = createStreamState(controller);
  const emit = createEmitter(output, controller, state);
  try {
    await consumeAgentEvents(runtime, turn, agent, controller, state, emit);
    const message = generatedMessage(state);
    await persistCompletion(runtime, turn, state, message);
    if (controller.signal.aborted) throw new Error('Turn cancelled');
    emit({
      type: 'done',
      message: {
        ...message,
        annotations: message.annotations ?? state.annotations,
        ...(state.contextCompacted ? { contextCompacted: true } : {}),
      },
      conversationId: turn.conversation.id,
      branchId: turn.branchId,
      title: turn.conversation.title,
      expiresAt: turn.conversation.expiresAt,
      ...(state.doneEvent?.annotationsHandled !== undefined
        ? { annotationsHandled: state.doneEvent.annotationsHandled }
        : {}),
    });
  } catch (error) {
    await persistFailure(runtime, turn, { ...state, controller }, error, emit);
  } finally {
    runtime.requestSignal.removeEventListener('abort', cancelFromRequest);
    removeActiveTurn(turn.turnId);
    try {
      output.close();
    } catch {
      /* response was already cancelled */
    }
  }
}

export function createTurnStream(runtime: TurnStreamRuntime, turn: PreparedTurn) {
  const controller = new AbortController();
  registerActiveTurn(turn.turnId, turn.conversation.id, controller);
  const cancelFromRequest = () => controller.abort('client disconnected');
  if (runtime.requestSignal.aborted) cancelFromRequest();
  else runtime.requestSignal.addEventListener('abort', cancelFromRequest, { once: true });
  const agent = createAgentService(runtime.env, (task) => runtime.executionCtx.waitUntil(task));
  return createDurableStream(
    (output) => runTurnStream(runtime, turn, controller, output, agent, cancelFromRequest),
    cancelFromRequest,
    (task) => runtime.executionCtx.waitUntil(task),
  );
}
