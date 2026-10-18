import type { NoteProposalEvent } from '@walden/contracts';
import { expect, it } from 'vitest';
import { createAgentService, OPENROUTER_DEFAULT_MODEL } from '../agent';

/** Live smoke tests run outside a Workflow, so each checkpoint just runs inline. */

const key = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_TEST_MODEL ?? OPENROUTER_DEFAULT_MODEL;

it.skipIf(!key)(
  'OpenRouter live inference: streams a Gemma answer through Mastra',
  async () => {
    const service = createAgentService({
      AI_PROVIDER: 'openrouter',
      AI_MODEL: model,
      OPENROUTER_API_KEY: key,
    });
    const stream = await service.streamTurn({
      ownerId: 'live-smoke-owner',
      turnId: 'openrouter-smoke-turn',
      requestId: 'openrouter-smoke-request',
      conversation: {
        id: 'openrouter-smoke-conversation',
        title: 'Test thread',
        noteId: null,
        messages: [],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        learningChecksEnabled: false,
        branchId: 'openrouter-smoke-branch',
        branches: [],
      },
      note: null,
      persona: {
        id: 'mentor',
        name: 'Mentor',
        prompt: 'Reply directly and briefly.',
        tone: 'neutral',
        brevity: 'brief',
        challenge: 'gentle',
      },
      message: 'Reply with exactly: openrouter is connected',
    });
    let text = '';
    for await (const event of stream) if (event.type === 'text-delta') text += event.delta;
    expect(text.toLowerCase()).toContain('openrouter is connected');
  },
  90_000,
);

it.skipIf(!key)(
  'OpenRouter live inference: returns a structured note suggestion for a concrete capture',
  async () => {
    const service = createAgentService({
      AI_PROVIDER: 'openrouter',
      AI_MODEL: model,
      OPENROUTER_API_KEY: key,
    });
    const stream = await service.streamNoteProposal(
      {
        turnId: 'openrouter-note-turn',
        requestId: 'openrouter-note-request',
        conversation: {
          id: 'openrouter-note-conversation',
          title: 'Fictional test',
          noteId: null,
          messages: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          learningChecksEnabled: false,
          branchId: 'openrouter-note-branch',
          branches: [],
        },
        note: null,
        persona: {
          id: 'mentor',
          name: 'Mentor',
          prompt: 'Reply directly and briefly.',
          tone: 'neutral',
          brevity: 'brief',
          challenge: 'gentle',
        },
        message: 'Remember that the fictional blue kite festival starts at noon.',
        noteProposalRequested: true,
      },
      {
        id: 'openrouter-note-assistant',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The fictional blue kite festival starts at noon.' }],
        metadata: { createdAt: new Date().toISOString() },
      },
    );
    let final: Extract<NoteProposalEvent, { type: 'done' | 'error' }> | undefined;
    for await (const event of stream)
      if (event.type === 'done' || event.type === 'error') final = event;
    expect(final).toMatchObject({ type: 'done' });
    if (final?.type === 'done') expect(final.proposal?.newText).toContain('noon');
  },
  90_000,
);
