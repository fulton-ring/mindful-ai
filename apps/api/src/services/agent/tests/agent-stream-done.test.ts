import { DEFAULT_PERSONAS, type WaldenUIMessageChunk } from '@walden/contracts';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../agent/mastra-turn', () => ({
  async *streamMastraTurn() {
    yield { type: 'text-start', id: 't' } satisfies WaldenUIMessageChunk;
    yield { type: 'text-delta', id: 't', delta: 'Answer' } satisfies WaldenUIMessageChunk;
    yield { type: 'text-end', id: 't' } satisfies WaldenUIMessageChunk;
  },
}));
vi.mock('../../mcp', () => ({ createMcpService: () => ({ tools: async () => ({}) }) }));
vi.mock('../../../agent/document-tool', () => ({ createDocumentTools: () => ({}) }));
vi.mock('../../research/research', () => ({
  createResearchTools: () => ({}),
  publicUrl: (url: string) => new URL(url),
}));
vi.mock('../../research/web-search', () => ({ createWebSearchTools: () => ({}) }));

import { streamTurnChunks } from '../agent-stream';

describe('turn stream completion', () => {
  it('completes without waiting for highlights or telemetry', async () => {
    const background = vi.fn();
    const events: WaldenUIMessageChunk[] = [];
    for await (const event of streamTurnChunks({
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
      memoryModel: {} as never,
      signal: new AbortController().signal,
      background,
    }))
      events.push(event);

    expect(events.at(-1)).toEqual({ type: 'text-end', id: 't' });
    // Highlights are follow-ups; the turn stream carries no annotation data.
    expect(JSON.stringify(events)).not.toContain('annotation');
    expect(background).toHaveBeenCalledOnce();
  });
});
