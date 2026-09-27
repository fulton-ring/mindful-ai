import { describe, expect, it } from 'vitest';
import { streamMastraTurn } from '../../../agent/mastra-turn';
import { createCloudflareModel, DEFAULT_AI_MODEL } from '../agent';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

describe.skipIf(!token || !accountId)('Cloudflare explicit note requests', () => {
  it.each([
    {
      name: 'one fact',
      message: 'Please add this to my note: The fictional observatory opens at noon. Version A.',
      expected: ['noon'],
    },
    {
      name: 'multiple facts',
      message:
        'Fictional interface test. Please suggest recording these three details as separate note additions: the reading room opens at eight; the courtyard fountain is marble; the west staircase has twelve steps. Reply briefly.',
      expected: ['eight', 'marble', 'twelve'],
    },
  ])(
    'acknowledges $name without asking permission or claiming it was saved',
    async ({ message, expected }) => {
      const events = streamMastraTurn({
        input: {
          turnId: 'live-note-request',
          requestId: 'live-note-request',
          conversation: {
            id: 'live-note-request',
            title: 'Fictional test',
            noteId: null,
            messages: [],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            learningChecksEnabled: false,
            branchId: 'branch',
            branches: [],
          },
          note: null,
          persona: {
            id: 'mentor',
            name: 'Mentor',
            prompt:
              'Help me think clearly. Be concise, specific, and willing to disagree. Let my own articulation lead.',
            tone: 'neutral',
            brevity: 'brief',
            challenge: 'gentle',
          },
          message,
        },
        model: createCloudflareModel(
          { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token },
          DEFAULT_AI_MODEL,
        ),
        signal: AbortSignal.timeout(75_000),
      });
      let text = '';
      for await (const event of events) if (event.type === 'text-delta') text += event.delta;
      for (const detail of expected) expect(text.toLowerCase()).toContain(detail);
      expect(text).not.toMatch(/\?|shall i|should i|would you like|confirm|proceed/i);
      expect(text).not.toMatch(/\b(?:saved|applied|added to your note)\b/i);
      expect(text).not.toMatch(/\b(?:I can record|separate notes)\b/i);
    },
    90_000,
  );
});
