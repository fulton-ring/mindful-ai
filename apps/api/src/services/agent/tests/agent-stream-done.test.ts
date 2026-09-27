import type { ChatEvent } from '@walden/contracts';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCheckpoints } from '../../../agent/checkpoints';

const done: Extract<ChatEvent, { type: 'done' }> = {
  type: 'done',
  message: { id: 'turn', role: 'assistant', content: 'Answer', createdAt: 'now' },
  conversationId: 'conversation',
  branchId: 'branch',
  title: 'Title',
  expiresAt: '2999-01-01',
};

vi.mock('../../../agent/mastra-turn', () => ({
  async *streamMastraTurn() {
    yield { type: 'text', text: 'Answer' } satisfies ChatEvent;
    yield done;
  },
}));
vi.mock('../../mcp', () => ({ createMcpService: () => ({ tools: async () => ({}) }) }));
vi.mock('../../../agent/document-tool', () => ({ createDocumentTools: () => ({}) }));
vi.mock('../../research/research', () => ({
  createResearchTools: () => ({}),
  publicUrl: (url: string) => new URL(url),
}));
vi.mock('../../research/web-search', () => ({ createWebSearchTools: () => ({}) }));

import { streamTurnEvents } from '../agent-stream';

const checkpoints: AgentCheckpoints = { do: (_name, callback) => callback() };

describe('turn stream completion', () => {
  it('completes without waiting for highlights or telemetry', async () => {
    const background = vi.fn();
    const events: ChatEvent[] = [];
    for await (const event of streamTurnEvents({
      env: {},
      input: {
        turnId: 'turn',
        requestId: 'request',
        conversation: {
          id: 'conversation',
          title: 'Title',
          noteId: null,
          messages: [],
          expiresAt: '2999-01-01',
          learningChecksEnabled: true,
          branchId: 'branch',
          branches: [],
        },
        note: null,
        persona: DEFAULT_PERSONAS[0]!,
        message: 'Question',
      },
      modelName: 'test-model',
      model: {} as never,
      signal: new AbortController().signal,
      checkpoints,
      background,
    }))
      events.push(event);

    expect(events.at(-1)).toMatchObject({ type: 'done', annotationsHandled: false });
    expect(events.some((event) => event.type === 'annotation')).toBe(false);
    expect(background).toHaveBeenCalledOnce();
  });
});
