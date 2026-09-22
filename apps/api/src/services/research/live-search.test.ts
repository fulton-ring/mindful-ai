import { type ChatEvent, DEFAULT_PERSONAS } from '@walden/contracts';
import { expect, it } from 'vitest';
import { createAgentService, DEFAULT_AI_MODEL } from '../agent/agent';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, OPENROUTER_API_KEY } = process.env;

it.skipIf(!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !OPENROUTER_API_KEY)(
  'searches an unfamiliar incident through the production Cloudflare provider',
  async () => {
    const service = createAgentService({
      AI_MODEL: DEFAULT_AI_MODEL,
      CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID,
      OPENROUTER_API_KEY,
    });
    const stream = await service.streamTurn({
      turnId: 'live-search-turn',
      requestId: 'live-search-request',
      conversation: {
        id: 'live-search',
        title: 'Search regression',
        noteId: null,
        messages: [],
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
        learningChecksEnabled: false,
        branchId: 'live-search-branch',
        branches: [],
      },
      note: null,
      persona: DEFAULT_PERSONAS.find(({ id }) => id === 'thinking-partner')!,
      message: 'Can you explain the huggingface attack to me?',
    });
    const events: ChatEvent[] = [];
    for await (const event of stream) events.push(event);
    expect(events.some((event) => event.type === 'tool' && event.tool.name === 'searchWeb')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'source')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  },
  300_000,
);
