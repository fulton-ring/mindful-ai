import type { Conversation } from '@walden/contracts';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stores: [] as unknown[],
  memories: [] as unknown[],
  init: vi.fn(),
  getThreadById: vi.fn(),
  saveThread: vi.fn(),
  recall: vi.fn(),
  deleteMessages: vi.fn(),
  saveMessages: vi.fn(),
  deleteThread: vi.fn(),
  settled: vi.fn(),
  clearObservationalMemory: vi.fn(),
  observe: vi.fn(),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

vi.mock('@mastra/cloudflare-d1', () => ({
  D1Store: class {
    init = mocks.init;
    stores: Record<string, unknown> = {};
    async getStore(name: string) {
      return this.stores[name];
    }
    constructor(config: unknown) {
      mocks.stores.push(config);
    }
  },
}));
vi.mock('../d1-observational-memory', () => ({
  D1ObservationalMemory: class {
    clearObservationalMemory = mocks.clearObservationalMemory;
  },
}));
vi.mock('../observation-model', () => ({ abortableObservationModel: (model: unknown) => model }));
vi.mock('@mastra/memory', () => ({
  Memory: class {
    getThreadById = mocks.getThreadById;
    saveThread = mocks.saveThread;
    recall = mocks.recall;
    deleteMessages = mocks.deleteMessages;
    saveMessages = mocks.saveMessages;
    deleteThread = mocks.deleteThread;
    settled = mocks.settled;
    estimateTokens = mocks.estimateTokens;
    omEngine = Promise.resolve({ observe: mocks.observe });
    constructor(config: unknown) {
      mocks.memories.push(config);
    }
  },
}));

import { deleteAgentMemoryThread, prepareAgentMemory } from '../memory';

const options = {
  model: {} as import('@ai-sdk/provider').LanguageModelV3,
  signal: new AbortController().signal,
};

const conversation = (count = 3): Conversation => ({
  id: 'thread',
  title: 'A thread',
  noteId: null,
  expiresAt: '2026-01-08T00:00:00.000Z',
  learningChecksEnabled: false,
  branchId: 'branch',
  branches: [],
  messages: Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? ('assistant' as const) : ('user' as const),
    parts: [
      { type: 'reasoning' as const, text: 'private reasoning' },
      { type: 'text' as const, text: `content-${index}` },
    ],
    metadata: {
      createdAt: new Date(index * 1_000).toISOString(),
      ...(index === count - 1 ? { status: 'interrupted' as const } : {}),
    },
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stores.length = 0;
  mocks.memories.length = 0;
  mocks.init.mockResolvedValue(undefined);
  mocks.getThreadById.mockResolvedValue(null);
  mocks.saveThread.mockImplementation(async ({ thread }) => thread);
  mocks.recall.mockResolvedValue({ messages: [{ id: 'stale' }], total: 1 });
  mocks.deleteMessages.mockResolvedValue(undefined);
  mocks.saveMessages.mockImplementation(async ({ messages }) => ({ messages }));
  mocks.deleteThread.mockResolvedValue(undefined);
  mocks.settled.mockResolvedValue(undefined);
  mocks.clearObservationalMemory.mockResolvedValue(undefined);
  mocks.observe.mockResolvedValue({ observed: false });
});

it('reconciles only the complete authoritative transcript without reasoning', async () => {
  const db = {} as D1Database;
  const result = await prepareAgentMemory(db, 'owner', conversation(42), options);

  expect(result).toMatchObject({
    threadId: 'conversation:owner:thread:branch:branch',
    resourceId: 'user:owner',
  });
  expect(mocks.deleteMessages).toHaveBeenCalledWith(['stale']);
  expect(mocks.clearObservationalMemory).toHaveBeenCalledWith(
    'conversation:owner:thread:branch:branch',
    'user:owner',
  );
  expect(mocks.observe).toHaveBeenCalledWith({
    threadId: 'conversation:owner:thread:branch:branch',
    resourceId: 'user:owner',
    messages: [],
    hooks: undefined,
  });
  const saved = mocks.saveMessages.mock.calls[0][0].messages;
  expect(saved).toHaveLength(42);
  expect(saved[0].id).toBe('message-0');
  expect(saved.at(-1).content.parts[0].text).toBe('content-41\n\n[Response interrupted]');
  expect(JSON.stringify(saved)).not.toContain('private reasoning');
  expect(mocks.stores).toEqual([
    expect.objectContaining({ id: 'walden-agent-memory', binding: db, tablePrefix: 'agent_' }),
  ]);
  expect(mocks.memories).toEqual([
    expect.objectContaining({
      options: expect.objectContaining({
        observationalMemory: expect.objectContaining({
          model: options.model,
          scope: 'thread',
          observation: expect.objectContaining({ bufferTokens: false }),
        }),
        readOnly: true,
        semanticRecall: false,
        generateTitle: false,
      }),
    }),
  ]);
});

it('reports only lifecycle phases started by native observational memory', async () => {
  const onLifecycle = vi.fn();
  mocks.observe.mockImplementation(async ({ hooks }) => {
    await hooks.onObservationStart();
    await hooks.onReflectionStart();
    await hooks.onReflectionEnd({ usage: { inputTokens: 20, outputTokens: 4 } });
    await hooks.onObservationEnd({ usage: { inputTokens: 100, outputTokens: 12 } });
    return { observed: true, reflected: true };
  });

  await prepareAgentMemory({} as D1Database, 'owner', conversation(), {
    ...options,
    onLifecycle,
  });

  expect(onLifecycle.mock.calls.map(([event]) => event)).toEqual([
    { phase: 'observation', state: 'start' },
    { phase: 'reflection', state: 'start' },
    {
      phase: 'reflection',
      state: 'end',
      usage: { inputTokens: 20, outputTokens: 4 },
    },
    {
      phase: 'observation',
      state: 'end',
      observed: true,
      usage: { inputTokens: 100, outputTokens: 12 },
    },
  ]);
});

it('does not report lifecycle activity when native observation is below threshold', async () => {
  const onLifecycle = vi.fn();

  await prepareAgentMemory({} as D1Database, 'owner', conversation(), {
    ...options,
    onLifecycle,
  });

  expect(onLifecycle).not.toHaveBeenCalled();
});

it('does not expose native observation provider failures', async () => {
  mocks.observe.mockRejectedValue(new Error('private provider error'));

  await expect(
    prepareAgentMemory({} as D1Database, 'owner', conversation(), options),
  ).rejects.toThrow('Conversation memory update failed.');
});

it('retains older turns rather than dropping them before observation', async () => {
  const db = {} as D1Database;
  mocks.recall.mockResolvedValue({ messages: [], total: 0 });

  await prepareAgentMemory(db, 'owner', conversation(41), options);

  const saved = mocks.saveMessages.mock.calls[0][0].messages;
  expect(saved[0].id).toBe('message-0');
  expect(saved[0].role).toBe('user');
});

it('invalidates observations when a response changes under the same ID', async () => {
  mocks.recall.mockResolvedValue({
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        content: { parts: [{ type: 'text', text: 'old answer' }] },
      },
    ],
  });
  await prepareAgentMemory({} as D1Database, 'owner', conversation(), options);
  expect(mocks.clearObservationalMemory).toHaveBeenCalledWith(
    'conversation:owner:thread:branch:branch',
    'user:owner',
  );
});

it('keeps observations when stored text differs only by trimmed whitespace', async () => {
  const thread = conversation(2);
  thread.messages[1]!.parts = [{ type: 'text', text: 'content-1\n' }];
  thread.messages[1]!.metadata = { createdAt: new Date(1_000).toISOString() };
  // The memory store keeps text trimmed.
  mocks.recall.mockResolvedValue({
    messages: [
      { id: 'message-0', role: 'user', content: { parts: [{ type: 'text', text: 'content-0' }] } },
      {
        id: 'message-1',
        role: 'assistant',
        content: { parts: [{ type: 'text', text: 'content-1' }] },
      },
    ],
  });
  await prepareAgentMemory({} as D1Database, 'owner', thread, options);
  expect(mocks.clearObservationalMemory).not.toHaveBeenCalled();
  expect(mocks.saveMessages).not.toHaveBeenCalled();
});

it('never observes an already-cancelled turn', async () => {
  await expect(
    prepareAgentMemory({} as D1Database, 'owner', conversation(), {
      ...options,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(mocks.observe).not.toHaveBeenCalled();
});

it('removes prepared memory if the thread was deleted while loading history', async () => {
  await expect(
    prepareAgentMemory({} as D1Database, 'owner', conversation(), {
      ...options,
      isActive: async () => false,
    }),
  ).rejects.toThrow('Thread is no longer active');
  expect(mocks.deleteThread).toHaveBeenCalledWith('conversation:owner:thread:branch:branch');
  expect(mocks.observe).not.toHaveBeenCalled();
});

it('reuses one native store per binding and deletes one branch-scoped thread', async () => {
  const db = {} as D1Database;
  mocks.recall.mockResolvedValue({ messages: [], total: 0 });

  await prepareAgentMemory(db, 'owner', conversation(), options);
  await prepareAgentMemory(db, 'owner', conversation(), options);
  await deleteAgentMemoryThread(db, 'owner', 'thread', 'branch');

  expect(mocks.stores).toHaveLength(1);
  expect(mocks.init).toHaveBeenCalledTimes(1);
  expect(mocks.deleteThread).toHaveBeenCalledWith('conversation:owner:thread:branch:branch');
  expect(mocks.settled).toHaveBeenCalled();
});

it('deletes every branch-scoped thread for a conversation when no branch is given', async () => {
  const all = vi.fn().mockResolvedValue({
    results: [{ id: 'main' }, { id: 'alternate' }],
  });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });
  const db = { prepare } as unknown as D1Database;

  await deleteAgentMemoryThread(db, 'owner', 'thread');

  expect(prepare).toHaveBeenCalledWith(
    'SELECT id FROM conversation_branches WHERE conversation_id=? AND owner_id=?',
  );
  expect(bind).toHaveBeenCalledWith('thread', 'owner');
  expect(mocks.deleteThread.mock.calls.map(([threadId]) => threadId)).toEqual([
    'conversation:owner:thread:branch:main',
    'conversation:owner:thread:branch:alternate',
  ]);
  expect(mocks.settled).toHaveBeenCalledTimes(2);
});
