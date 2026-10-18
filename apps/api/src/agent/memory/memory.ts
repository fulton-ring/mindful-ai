import type { LanguageModelV3 } from '@ai-sdk/provider';
import { D1Store } from '@mastra/cloudflare-d1';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { type Conversation, uiMessageText } from '@walden/contracts';
import { isInterrupted } from '../../chat/messages';
import type { AppDatabase } from '../../db/database';

import { D1ObservationalMemory } from './d1-observational-memory';
import { abortableObservationModel } from './observation-model';

export type MemoryLifecycleEvent = {
  phase: 'observation' | 'reflection';
  state: 'start' | 'end';
  observed?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: Error;
};

const stores = new WeakMap<object, Promise<MastraCompositeStore>>();
/**
 * Older messages are summarized once they pass this many tokens. The models'
 * windows are 256k+, so the threshold is set by cost and latency, not capacity;
 * the per-step input budget (`agent/context.ts`) must stay above it plus the
 * retained floor, or messages would be trimmed before they are summarized.
 */
export const OBSERVATION_TOKEN_THRESHOLD = 48_000;
const REFLECTION_TOKEN_THRESHOLD = 12_000;
const RECENT_MESSAGE_TOKEN_RETENTION = 12_000;

const identity = (ownerId: string, conversationId: string, branchId: string) => ({
  threadId: `conversation:${ownerId}:${conversationId}:branch:${branchId}`,
  resourceId: `user:${ownerId}`,
});

/** Host startup binds native libSQL/Postgres memory to the application database. */
export function registerAgentMemoryStore(db: AppDatabase, storage: MastraCompositeStore) {
  stores.set(db.identity ?? db, Promise.resolve(storage));
}

function storeFor(db: AppDatabase): Promise<MastraCompositeStore> {
  const existing = stores.get(db.identity ?? db);
  if (existing) return existing;
  if (db.dialect) throw new Error('Native agent memory storage is not configured');
  const initialized = (async () => {
    const storage = new D1Store({
      id: 'walden-agent-memory',
      binding: db as D1Database,
      tablePrefix: 'agent_',
    });
    storage.stores.memory = new D1ObservationalMemory({
      binding: db as D1Database,
      tablePrefix: 'agent_',
    });
    await storage.init();
    return storage;
  })();
  stores.set(db.identity ?? db, initialized);
  // A transient initialization failure must not poison every subsequent turn.
  void initialized.catch(() => stores.delete(db.identity ?? db));
  return initialized;
}

function createObservationalMemory(
  storage: MastraCompositeStore,
  model: LanguageModelV3,
  signal: AbortSignal,
  observeAt = OBSERVATION_TOKEN_THRESHOLD,
) {
  return new Memory({
    storage,
    options: {
      readOnly: true,
      workingMemory: { enabled: false },
      semanticRecall: false,
      generateTitle: false,
      observationalMemory: {
        model: abortableObservationModel(model, signal),
        scope: 'thread',
        observation: {
          messageTokens: observeAt,
          bufferTokens: false,
          modelSettings: { maxOutputTokens: 4_000, temperature: 0.1 },
          instruction:
            'Preserve user decisions, constraints, unresolved questions, and corrections. Distinguish user statements from assistant claims. Do not turn uncertain claims into facts.',
        },
        // Mastra's recall tool: summaries keep links to the messages they came from,
        // so the model can reread exact wording. Scoped to this conversation branch.
        retrieval: { scope: 'thread' },
        reflection: {
          observationTokens: REFLECTION_TOKEN_THRESHOLD,
          modelSettings: { maxOutputTokens: 3_000, temperature: 0 },
        },
      },
    },
  });
}

const messageText = (message: MastraDBMessage) =>
  message.content.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

export function messagesBeforeRecentTokenFloor(
  memory: Memory,
  messages: MastraDBMessage[],
  tokenFloor = RECENT_MESSAGE_TOKEN_RETENTION,
): MastraDBMessage[] {
  let retainedTokens = 0;
  let cutoff = messages.length;
  while (cutoff > 0 && retainedTokens < tokenFloor) {
    retainedTokens += memory.estimateTokens(messageText(messages[cutoff - 1]!));
    cutoff -= 1;
  }
  return messages.slice(0, cutoff);
}

const toMemoryMessage = (
  message: Conversation['messages'][number],
  threadId: string,
  resourceId: string,
): MastraDBMessage => ({
  id: message.id,
  role: message.role,
  createdAt: new Date(message.metadata?.createdAt ?? 0),
  threadId,
  resourceId,
  content: {
    format: 2,
    parts: [
      {
        type: 'text',
        text:
          message.role === 'assistant' && isInterrupted(message)
            ? `${uiMessageText(message)}\n\n[Response interrupted]`
            : uiMessageText(message),
      },
    ],
  },
});

export type PreparedMemory = {
  activate?: () => Promise<void>;
  memory: Memory;
  threadId: string;
  resourceId: string;
  /** Conversation tokens the model receives; undefined when it could not be read. */
  contextTokens?: number;
};

type PrepareMemoryOptions = {
  deferWrites?: boolean;
  model: LanguageModelV3;
  signal: AbortSignal;
  isActive?: () => Promise<boolean>;
  onLifecycle?: (event: MemoryLifecycleEvent) => void;
};

async function syncConversationMessages(
  storage: MastraCompositeStore,
  memory: Memory,
  conversation: Conversation,
  threadId: string,
  resourceId: string,
) {
  const recent = conversation.messages;
  const firstUser = recent.findIndex(({ role }) => role === 'user');
  const messages = (firstUser < 0 ? [] : recent.slice(firstUser)).map((message) =>
    toMemoryMessage(message, threadId, resourceId),
  );
  const updatedAt = new Date(messages.at(-1)?.createdAt ?? Date.now());
  const prior = await memory.getThreadById({ threadId, resourceId });
  await memory.saveThread({
    thread: {
      id: threadId,
      resourceId,
      title: conversation.title,
      createdAt: prior?.createdAt ?? new Date(messages.at(0)?.createdAt ?? updatedAt),
      updatedAt,
    },
  });
  const stored = await memory.recall({ threadId, resourceId, page: 0, perPage: false });
  const authoritativeIds = new Set(messages.map(({ id }) => id));
  const byId = new Map(stored.messages.map((message) => [message.id, message]));
  // Stored text comes back trimmed, so compare trimmed text: otherwise any reply
  // ending in whitespace reads as edited, clearing and redoing the summary each turn.
  const changed = messages.filter((message) => {
    const previous = byId.get(message.id);
    return (
      previous &&
      (previous.role !== message.role ||
        messageText(previous).trim() !== messageText(message).trim())
    );
  });
  const staleIds = stored.messages.map(({ id }) => id).filter((id) => !authoritativeIds.has(id));
  if (staleIds.length || changed.length) {
    // Regeneration/recovery must not retain observations of the replaced answer.
    await (await storage.getStore('memory'))!.clearObservationalMemory(threadId, resourceId);
  }
  if (staleIds.length) await memory.deleteMessages(staleIds);
  const changedIds = new Set(changed.map(({ id }) => id));
  const additions = messages.filter(({ id }) => !byId.has(id) || changedIds.has(id));
  if (additions.length) await memory.saveMessages({ messages: additions });
  return messages;
}

async function observeConversation(
  memory: Memory,
  engine: NonNullable<Awaited<Memory['omEngine']>>,
  messages: MastraDBMessage[],
  threadId: string,
  resourceId: string,
  lifecycle?: (event: MemoryLifecycleEvent) => void,
) {
  let observationEnd: { usage?: MemoryLifecycleEvent['usage']; error?: Error } | undefined;
  const observationResult = await engine.observe({
    threadId,
    resourceId,
    messages: messagesBeforeRecentTokenFloor(memory, messages),
    hooks: lifecycle
      ? {
          onObservationStart: () => lifecycle({ phase: 'observation', state: 'start' }),
          onObservationEnd: ({ usage, error }) => {
            if (error) lifecycle({ phase: 'observation', state: 'end', usage, error });
            else observationEnd = { usage };
          },
          onReflectionStart: () => lifecycle({ phase: 'reflection', state: 'start' }),
          onReflectionEnd: ({ usage, error }) =>
            lifecycle({ phase: 'reflection', state: 'end', usage, error }),
        }
      : undefined,
  });
  if (observationEnd)
    lifecycle?.({
      phase: 'observation',
      state: 'end',
      observed: observationResult.observed,
      ...observationEnd,
    });
}

export async function prepareAgentMemory(
  db: AppDatabase,
  ownerId: string,
  conversation: Conversation,
  options: PrepareMemoryOptions,
): Promise<PreparedMemory> {
  options.signal.throwIfAborted();
  const storage = await storeFor(db);
  const memory = createObservationalMemory(storage, options.model, options.signal);
  const { threadId, resourceId } = identity(ownerId, conversation.id, conversation.branchId);
  if (options.deferWrites)
    return {
      memory,
      threadId,
      resourceId,
      activate: async () => {
        await prepareAgentMemory(db, ownerId, conversation, { ...options, deferWrites: false });
      },
    };
  const messages = await syncConversationMessages(
    storage,
    memory,
    conversation,
    threadId,
    resourceId,
  );
  const assertActive = async () => {
    if (options.isActive && !(await options.isActive())) {
      await memory.deleteThread(threadId);
      await memory.settled();
      throw new Error('Thread is no longer active.');
    }
  };
  await assertActive();
  options.signal.throwIfAborted();
  const engine = await memory.omEngine;
  if (!engine) throw new Error('D1 observational memory is unavailable.');
  // Native observe checks its own token threshold and reflects when needed.
  // Await it over committed history; main-agent writes remain read-only.
  try {
    await observeConversation(memory, engine, messages, threadId, resourceId, options.onLifecycle);
  } catch {
    options.signal.throwIfAborted();
    throw new Error('Conversation memory update failed.');
  } finally {
    await assertActive();
  }
  options.signal.throwIfAborted();
  return {
    memory,
    threadId,
    resourceId,
    contextTokens: await contextTokens(engine, threadId, resourceId, messages),
  };
}

/** Roughly how many conversation tokens the model receives: summaries plus unsummarized messages. */
async function contextTokens(
  engine: NonNullable<Awaited<Memory['omEngine']>>,
  threadId: string,
  resourceId: string,
  messages: MastraDBMessage[],
): Promise<number | undefined> {
  try {
    const status = await engine.getStatus({ threadId, resourceId, messages });
    return status.pendingTokens + (status.record.observationTokenCount ?? 0);
  } catch {
    return undefined;
  }
}

/**
 * Summarizes the conversation now, at the model's request, whatever its size:
 * everything before the retained recent messages becomes observations, and a
 * `focus` also condenses them around what must be kept. Takes effect from the
 * next turn, whose context is loaded from memory.
 */
export async function compactAgentMemory(
  db: AppDatabase,
  ownerId: string,
  conversation: Conversation,
  options: { model: LanguageModelV3; signal: AbortSignal; focus?: string },
): Promise<{ compacted: boolean; summaryTokens: number }> {
  const storage = await storeFor(db);
  // A threshold of one token makes this observation unconditional.
  const memory = createObservationalMemory(storage, options.model, options.signal, 1);
  const { threadId, resourceId } = identity(ownerId, conversation.id, conversation.branchId);
  const engine = await memory.omEngine;
  if (!engine) throw new Error('D1 observational memory is unavailable.');
  const { messages } = await memory.recall({ threadId, resourceId, page: 0, perPage: false });
  const older = messagesBeforeRecentTokenFloor(memory, messages);
  let result = older.length
    ? await engine.observe({ threadId, resourceId, messages: older })
    : { observed: false, reflected: false, record: undefined };
  if (options.focus) {
    const reflection = await engine.reflect(threadId, resourceId, options.focus);
    result = { ...result, reflected: reflection.reflected, record: reflection.record };
  }
  await memory.settled();
  return {
    compacted: result.observed || result.reflected,
    summaryTokens: result.record?.observationTokenCount ?? 0,
  };
}

export async function deleteAgentMemoryThread(
  db: AppDatabase,
  ownerId: string,
  conversationId: string,
  branchId?: string,
): Promise<void> {
  const storage = await storeFor(db);
  const memory = new Memory({ storage });
  const branchIds = branchId
    ? [branchId]
    : (
        await db
          .prepare('SELECT id FROM conversation_branches WHERE conversation_id=? AND owner_id=?')
          .bind(conversationId, ownerId)
          .all<{ id: string }>()
      ).results.map(({ id }) => id);
  for (const id of branchIds) {
    const { threadId, resourceId } = identity(ownerId, conversationId, id);
    await memory.deleteThread(threadId);
    await memory.settled();
    await (await storage.getStore('memory'))!.clearObservationalMemory(threadId, resourceId);
  }
}
