import type { LanguageModelV3 } from '@ai-sdk/provider';
import { D1Store } from '@mastra/cloudflare-d1';
import type { MastraDBMessage } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { type Conversation, uiMessageText } from '@walden/contracts';
import { isInterrupted } from '../../chat/messages';

import { D1ObservationalMemory } from './d1-observational-memory';
import { abortableObservationModel } from './observation-model';

export type MemoryLifecycleEvent = {
  phase: 'observation' | 'reflection';
  state: 'start' | 'end';
  observed?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: Error;
};

const stores = new WeakMap<D1Database, Promise<D1Store>>();
const OBSERVATION_TOKEN_THRESHOLD = 12_000;
const REFLECTION_TOKEN_THRESHOLD = 4_000;
const RECENT_MESSAGE_TOKEN_RETENTION = 6_000;

const identity = (ownerId: string, conversationId: string, branchId: string) => ({
  threadId: `conversation:${ownerId}:${conversationId}:branch:${branchId}`,
  resourceId: `user:${ownerId}`,
});

function storeFor(db: D1Database): Promise<D1Store> {
  const existing = stores.get(db);
  if (existing) return existing;
  const initialized = (async () => {
    const storage = new D1Store({
      id: 'walden-agent-memory',
      binding: db,
      tablePrefix: 'agent_',
    });
    storage.stores.memory = new D1ObservationalMemory({ binding: db, tablePrefix: 'agent_' });
    await storage.init();
    return storage;
  })();
  stores.set(db, initialized);
  // A transient initialization failure must not poison every subsequent turn.
  void initialized.catch(() => stores.delete(db));
  return initialized;
}

function createObservationalMemory(storage: D1Store, model: LanguageModelV3, signal: AbortSignal) {
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
          messageTokens: OBSERVATION_TOKEN_THRESHOLD,
          bufferTokens: false,
          modelSettings: { maxOutputTokens: 4_000, temperature: 0.1 },
          instruction:
            'Preserve user decisions, constraints, unresolved questions, and corrections. Distinguish user statements from assistant claims. Do not turn uncertain claims into facts.',
        },
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

type PrepareMemoryOptions = {
  model: LanguageModelV3;
  signal: AbortSignal;
  isActive?: () => Promise<boolean>;
  onLifecycle?: (event: MemoryLifecycleEvent) => void;
};

async function syncConversationMessages(
  storage: D1Store,
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
  const changed = messages.filter((message) => {
    const previous = byId.get(message.id);
    return (
      previous && (previous.role !== message.role || messageText(previous) !== messageText(message))
    );
  });
  const staleIds = stored.messages.map(({ id }) => id).filter((id) => !authoritativeIds.has(id));
  if (staleIds.length || changed.length) {
    // Regeneration/recovery must not retain observations of the replaced answer.
    await storage.stores.memory!.clearObservationalMemory(threadId, resourceId);
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
  db: D1Database,
  ownerId: string,
  conversation: Conversation,
  options: PrepareMemoryOptions,
): Promise<{ memory: Memory; threadId: string; resourceId: string }> {
  options.signal.throwIfAborted();
  const storage = await storeFor(db);
  const memory = createObservationalMemory(storage, options.model, options.signal);
  const { threadId, resourceId } = identity(ownerId, conversation.id, conversation.branchId);
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
  return { memory, threadId, resourceId };
}

export async function deleteAgentMemoryThread(
  db: D1Database,
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
  for (const id of branchIds)
    await memory.deleteThread(identity(ownerId, conversationId, id).threadId);
  await memory.settled();
}
