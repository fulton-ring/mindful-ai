import type { Message } from '@walden/contracts';
import type { AgentTurnInput } from '../../../services/types';

type NoteProposalStream = typeof import('../../index')['streamNoteProposal'];

export const model = {} as Parameters<NoteProposalStream>[2];

export const assistantMessage: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content:
    'Sunlight refracts and disperses as it enters a raindrop. It reflects inside the drop, then refracts again as it exits. Different wavelengths leave at different angles, producing the visible arc.',
  createdAt: '2026-09-18T12:00:00.000Z',
};

export const input = (
  message: string,
  noteProposalRequested = false,
  overrides: Partial<AgentTurnInput> = {},
): AgentTurnInput => ({
  turnId: 'turn-1',
  requestId: 'request-1',
  conversation: {
    id: 'conversation-1',
    title: 'Rainbow',
    noteId: null,
    messages: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
    learningChecksEnabled: false,
    branchId: 'branch',
    branches: [],
  },
  note: null,
  persona: {
    id: 'mentor',
    name: 'Mentor',
    prompt: '',
    brevity: 'brief',
    challenge: 'balanced',
    tone: 'neutral',
    revision: 0,
  },
  message,
  noteProposalRequested,
  ...overrides,
});

export function objectStream(...values: unknown[]) {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}
