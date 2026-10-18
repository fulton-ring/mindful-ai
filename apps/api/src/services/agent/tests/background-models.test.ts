import { DEFAULT_PERSONAS, type WaldenUIMessage } from '@walden/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from '../../types';

type Model = { modelId: string };
const captured = vi.hoisted(() => ({}) as Record<string, { modelId: string }>);
const memoryFence = vi.hoisted(() => ({
  isActive: undefined as (() => Promise<boolean>) | undefined,
}));
vi.mock('../../../agent/memory/memory', () => ({
  prepareAgentMemory: async (
    _db: unknown,
    _owner: unknown,
    _conversation: unknown,
    options: { isActive?: () => Promise<boolean> },
  ) => {
    memoryFence.isActive = options.isActive;
  },
}));
vi.mock('../agent-stream', () => ({
  streamTurnChunks: (options: { model: Model; memoryModel: Model }) => {
    captured.reply = options.model;
    captured.memory = options.memoryModel;
    return (async function* () {})();
  },
}));
vi.mock('../../../agent/stream-events', () => ({
  agentTrace: () => undefined,
  annotateResponse: async ({ model }: { model: Model }) => {
    captured.highlights = model;
    return [];
  },
  streamAnnotationResponse: async function* () {},
}));
vi.mock('../../../agent/note-proposals/note-proposal-stream', () => ({
  streamNoteProposal: (_input: unknown, _message: unknown, model: Model) => {
    captured.notes = model;
    return (async function* () {})();
  },
}));

import { createAgentService, DEFAULT_AI_MODEL } from '../agent';

const QWEN = '@cf/qwen/qwen3.8-27b';
const input = {
  turnId: 'turn',
  requestId: 'request',
  conversation: { id: 'conversation', messages: [] },
  note: null,
  persona: { ...DEFAULT_PERSONAS[0]!, model: QWEN },
  message: 'Question',
} as unknown as AgentTurnInput;
const reply = {
  id: 'a',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Answer.' }],
} as WaldenUIMessage;

beforeEach(() => {
  for (const key of Object.keys(captured)) delete captured[key];
});

describe('model per task', () => {
  it('uses an explicit background model independently of the reply', async () => {
    const agent = createAgentService({
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://localhost:4321/v1',
      AI_MODEL: 'default',
      AI_BACKGROUND_MODEL: 'fast',
    });
    await agent.streamTurn({ ...input, persona: { ...input.persona, model: undefined } });
    await agent.annotateTurn(input, reply);
    expect(captured.reply?.modelId).toBe('default');
    expect(captured.memory?.modelId).toBe('fast');
    expect(captured.highlights?.modelId).toBe('fast');
  });
  it("writes the reply with the persona's model and does background work on the default model", async () => {
    const agent = createAgentService({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'token',
    });
    await agent.streamTurn(input);
    await agent.annotateTurn(input, reply);
    for await (const _ of await agent.streamNoteProposal(input, reply)) {
      /* drain */
    }
    expect(captured.reply?.modelId).toBe(QWEN);
    expect(captured.memory?.modelId).toBe(DEFAULT_AI_MODEL);
    expect(captured.highlights?.modelId).toBe(DEFAULT_AI_MODEL);
    expect(captured.notes?.modelId).toBe(DEFAULT_AI_MODEL);
  });
});

it('keeps the admitted primary model pinned when the runtime default changes', async () => {
  const agent = createAgentService(
    { AI: {} as Ai, AI_MODEL: '@cf/custom/new-default' },
    undefined,
    {
      model: '@cf/custom/admitted',
    } as import('../../../execution/native-agent').NativeExecutionContext,
  );
  await agent.streamTurn({ ...input, persona: { ...input.persona, model: undefined } });
  expect(captured.reply?.modelId).toBe('@cf/custom/admitted');
});

it('passes a live-conversation fence to background memory updates', async () => {
  const first = vi.fn().mockResolvedValue(null);
  const statement = { bind: vi.fn(), first };
  statement.bind.mockReturnValue(statement);
  const DB = { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database;
  const agent = createAgentService({ AI: {} as Ai, DB });
  await agent.updateMemory({ ...input, ownerId: 'owner' });
  expect(memoryFence.isActive).toBeTypeOf('function');
  await expect(memoryFence.isActive!()).resolves.toBe(false);
  expect(DB.prepare).toHaveBeenCalledWith(expect.stringContaining('conversations'));
});
