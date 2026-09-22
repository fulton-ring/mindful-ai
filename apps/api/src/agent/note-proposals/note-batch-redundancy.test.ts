import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  options: vi.fn(),
  primitives: vi.fn(),
}));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    stream = mocks.stream;
    __registerPrimitives = mocks.primitives;
  },
}));

import type { Message } from '@walden/contracts';
import type { AgentTurnInput } from '../../services/types';
import { streamNoteProposal } from '../index';

const model = {} as Parameters<typeof streamNoteProposal>[2];
const assistantMessage: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'Beta ships March 21, pilot capped at 50 users, run by Priya.',
  createdAt: '2026-09-18T12:00:00.000Z',
};

const objectStream = (...values: unknown[]) =>
  new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });

const input = (markdown: string): AgentTurnInput => ({
  turnId: 'turn-1',
  requestId: 'request-1',
  conversation: {
    id: 'conversation-1',
    title: 'Launch',
    noteId: 'note',
    messages: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
    learningChecksEnabled: false,
    branchId: 'branch',
    branches: [],
  },
  note: {
    id: 'note',
    title: 'Launch',
    markdown,
    revision: 2,
    provenance: [],
    createdAt: 'now',
    updatedAt: 'now',
  },
  persona: {
    id: 'mentor',
    name: 'Mentor',
    prompt: '',
    brevity: 'brief',
    challenge: 'balanced',
    tone: 'neutral',
    revision: 0,
  },
  message: 'Actually we moved it to March 21. Also Priya is running the pilot.',
  noteProposalRequested: false,
});

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.options.mockReset();
  mocks.primitives.mockReset();
});

it('keeps only one operation when two restate the same correction', async () => {
  const markdown =
    'Team will ship the beta on March 14 and cap the pilot at 50 users.\n\n- Beta ships March 14, pilot capped at 50 users.';
  const operations = [
    {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'Team will ship the beta on March 14 and cap the pilot at 50 users.',
      newText: 'Team will ship the beta on March 21 and cap the pilot at 50 users, run by Priya.',
      reason: 'Records the new date and owner.',
    },
    {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: '- Beta ships March 14, pilot capped at 50 users.',
      newText: '- Beta ships March 21, pilot capped at 50 users, run by Priya.',
      reason: 'Records the new date and owner.',
    },
  ] as const;
  const batch = { operations, reason: '' };
  mocks.stream.mockResolvedValue({
    objectStream: objectStream(batch),
    object: Promise.resolve(batch),
  });

  const events = [];
  for await (const event of streamNoteProposal(
    input(markdown),
    assistantMessage,
    model,
    new AbortController().signal,
  ))
    events.push(event);

  const done = events.at(-1);
  if (done?.type !== 'done') throw new Error('Expected done event');
  expect(done.proposals).toHaveLength(1);
  expect(done.proposals?.[0]?.newText).toContain('March 21');
});

it('keeps both operations when they record genuinely different facts', async () => {
  const markdown = 'Beta ships March 14.\n\nOpen question: staffing.';
  const operations = [
    {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'Beta ships March 14.',
      newText: 'Beta ships March 21.',
      reason: 'Records the new date.',
    },
    {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'Open question: staffing.',
      newText: 'Priya is running the pilot.',
      reason: 'Records the owner.',
    },
  ] as const;
  const batch = { operations, reason: '' };
  mocks.stream.mockResolvedValue({
    objectStream: objectStream(batch),
    object: Promise.resolve(batch),
  });

  const events = [];
  for await (const event of streamNoteProposal(
    input(markdown),
    assistantMessage,
    model,
    new AbortController().signal,
  ))
    events.push(event);

  const done = events.at(-1);
  if (done?.type !== 'done') throw new Error('Expected done event');
  expect(done.proposals).toHaveLength(2);
});
