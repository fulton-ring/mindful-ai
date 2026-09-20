import { describe, expect, it } from 'vitest';
import { createAgentService, DEFAULT_AI_MODEL } from './agent';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

describe.skipIf(!token || !accountId)('Cloudflare live inference', () => {
  it('streams a real Gemma response through Mastra', async () => {
    const service = createAgentService({
      AI_MODEL: DEFAULT_AI_MODEL,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: token,
    });
    const events = await service.streamTurn({
      turnId: 'live-smoke-turn',
      requestId: 'live-smoke-request',
      conversation: {
        id: 'live-smoke-conversation',
        title: 'New conversation',
        noteId: null,
        messages: [],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        learningChecksEnabled: false,
        branchId: 'branch',
        branches: [],
      },
      note: null,
      persona: {
        id: 'live-smoke-persona',
        name: 'Concise',
        prompt: 'Reply directly and briefly.',
        brevity: 'brief',
        challenge: 'gentle',
        tone: 'neutral',
        revision: 0,
      },
      message: 'Reply with exactly: walden live',
    });
    let text = '';
    let finished = false;
    for await (const event of events) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'done') finished = true;
    }
    expect(text.toLowerCase()).toContain('walden live');
    expect(finished).toBe(true);
  }, 90_000);

  it('manual duplicate proposal uses the current note reason despite an earlier no-note preference', async () => {
    const sentence = 'The fictional observatory opens at noon.';
    const service = createAgentService({
      AI_MODEL: DEFAULT_AI_MODEL,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: token,
    });
    const stream = await service.streamNoteProposal(
      {
        turnId: 'live-duplicate-turn',
        requestId: 'live-duplicate-request',
        conversation: {
          id: 'live-duplicate-conversation',
          title: 'Fictional test',
          noteId: 'live-duplicate-note',
          messages: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          learningChecksEnabled: false,
          branchId: 'branch',
          branches: [],
        },
        note: {
          id: 'live-duplicate-note',
          title: 'Fictional test',
          markdown: `${sentence} Version A.`,
          revision: 1,
          provenance: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        persona: {
          id: 'live-duplicate-persona',
          name: 'Concise',
          prompt: 'Reply directly and briefly.',
          brevity: 'brief',
          challenge: 'gentle',
          tone: 'neutral',
          revision: 0,
        },
        message: `For this fictional test, restate only this sentence: ${sentence} Do not propose a note automatically.`,
        noteProposalRequested: true,
      },
      {
        id: 'live-duplicate-assistant',
        role: 'assistant',
        content: sentence,
        createdAt: new Date().toISOString(),
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const done = events.find((event) => event.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.proposal).toBeNull();
      expect(done.reason?.toLowerCase()).toMatch(/already|duplicat|existing|covered|no new/);
      expect(done.reason?.toLowerCase()).not.toMatch(/requested.*not|no.note preference/);
    }
  }, 90_000);

  it('manual correction already present becomes a contextual no-op', async () => {
    const current = 'The fictional observatory opens at one. Version A.';
    const service = createAgentService({
      AI_MODEL: DEFAULT_AI_MODEL,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: token,
    });
    const stream = await service.streamNoteProposal(
      {
        turnId: 'live-correction-turn',
        requestId: 'live-correction-request',
        conversation: {
          id: 'live-correction-conversation',
          title: 'Fictional test',
          noteId: 'live-correction-note',
          messages: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          learningChecksEnabled: false,
          branchId: 'branch',
          branches: [],
        },
        note: {
          id: 'live-correction-note',
          title: 'Fictional test',
          markdown: current,
          revision: 2,
          provenance: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        persona: {
          id: 'live-correction-persona',
          name: 'Concise',
          prompt: 'Reply directly and briefly.',
          brevity: 'brief',
          challenge: 'gentle',
          tone: 'neutral',
          revision: 0,
        },
        message: 'The observatory opens at one now. Update just the opening time.',
        noteProposalRequested: true,
      },
      {
        id: 'live-correction-assistant',
        role: 'assistant',
        content: `I will propose an update to your note to change the opening time to one.\n\nProposed change:\n"${current}"\n\nShould I apply this change?`,
        createdAt: new Date().toISOString(),
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const done = events.find((event) => event.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.proposal).toBeNull();
      expect(done.reason?.toLowerCase()).toMatch(/already|current|existing|covered|no change/);
    }
  }, 90_000);
});
