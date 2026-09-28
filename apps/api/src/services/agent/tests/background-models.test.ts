import { DEFAULT_PERSONAS, type WaldenUIMessage } from '@walden/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from '../../types';

type Model = { modelId: string };
const captured = vi.hoisted(() => ({}) as Record<string, { modelId: string }>);
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
