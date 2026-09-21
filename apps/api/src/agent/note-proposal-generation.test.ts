// biome-ignore lint/style/noExcessiveLinesPerFile: this integration scenario file keeps the streaming matrix together.
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { AgentTurnInput } from '../services/types';
import {
  noteProposalBatchOutputSchema,
  noteProposalFromCandidate,
  streamNoteProposal,
} from './index';

const model = {} as Parameters<typeof streamNoteProposal>[2];
const assistantMessage: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content:
    'Sunlight refracts and disperses as it enters a raindrop. It reflects inside the drop, then refracts again as it exits. Different wavelengths leave at different angles, producing the visible arc.',
  createdAt: '2026-09-18T12:00:00.000Z',
};
const input = (
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

function objectStream(...values: unknown[]) {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the capture-basis scenarios share one mocked stream harness.
describe('note proposal capture basis', () => {
  beforeEach(() => {
    mocks.stream.mockReset();
    mocks.options.mockReset();
    mocks.primitives.mockReset();
  });

  it('gives a large note an outline and reading tools without duplicating its body', async () => {
    mocks.stream.mockRejectedValue(new Error('stop after input inspection'));
    const largeNote = {
      id: 'note-1',
      title: 'Research',
      markdown: `# Start\n${'secret'.repeat(10_000)}\n# End`,
      revision: 3,
      provenance: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    for await (const _event of streamNoteProposal(
      input('Update the ending', true, { note: largeNote }),
      assistantMessage,
      model,
      new AbortController().signal,
    )) {
      // The mocked model stops before producing a proposal.
    }
    const task = mocks.stream.mock.calls[0]?.[0] as string;
    expect(task).toContain('currentNoteOutline');
    expect(task).not.toContain('secretsecretsecret');
    expect(mocks.options.mock.calls[0]?.[0]?.tools).toHaveProperty('readNote');
    expect(mocks.options.mock.calls[0]?.[0]?.tools).toHaveProperty('searchNote');
  });

  it.each([
    [
      'Workers AI API error (429 Too Many Requests): daily free allocation exceeded',
      'AI replies are unavailable because the provider’s daily allowance has been reached. Try again after it resets.',
    ],
    ['structured output failed', 'Note proposal generation failed.'],
  ])(
    'reports the actual generation failure without inventing a note rejection: %s',
    async (failure, expected) => {
      mocks.stream.mockRejectedValue(new Error(failure));
      const events = [];
      for await (const event of streamNoteProposal(
        input('Please suggest a note', true),
        assistantMessage,
        model,
        new AbortController().signal,
      ))
        events.push(event);
      expect(events).toEqual([{ type: 'error', message: expected }]);
      expect(mocks.stream).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts a valid operation batch without a batch-level reason', () => {
    expect(
      noteProposalBatchOutputSchema.parse({
        operations: [
          {
            shouldPropose: true,
            captureBasis: 'user_decision',
            mode: 'replace',
            oldText: 'Old wording.',
            newText: 'Corrected wording.',
            reason: 'Records the correction.',
          },
        ],
      }),
    ).toMatchObject({ operations: [{ reason: 'Records the correction.' }] });
  });

  it('does not preview or finalize a generic educational recap classified as none', async () => {
    const candidate = {
      shouldPropose: true,
      captureBasis: 'none',
      oldText: '',
      newText: '- Rainbows form through refraction, reflection, and dispersion.',
      reason: 'Summarizes the mechanism.',
    } as const;
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(candidate),
      object: Promise.resolve(candidate),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('What makes a rainbow appear? Explain the mechanism in three sentences.'),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([{ type: 'done', proposal: null, reason: 'Summarizes the mechanism.' }]);
  });

  it('tells the manual proposer to override an earlier no-note preference', async () => {
    const candidate = {
      shouldPropose: false,
      captureBasis: 'none',
      mode: 'add',
      oldText: '',
      newText: '',
      reason: 'Already covered in the note.',
    } as const;
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(candidate),
      object: Promise.resolve(candidate),
    });

    for await (const _event of streamNoteProposal(
      input('Do not propose a note automatically.', true),
      assistantMessage,
      model,
      new AbortController().signal,
    )) {
      // consume the stream
    }

    expect(mocks.options.mock.calls[0]?.[0].instructions).toContain(
      'overrides any earlier request not to propose a note',
    );
  });

  it('constrains explicit corrections to the requested local replacement', async () => {
    const candidate = {
      shouldPropose: false,
      captureBasis: 'none',
      mode: 'replace',
      oldText: '',
      newText: '',
      reason: 'No safe edit was identified.',
    } as const;
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(candidate),
      object: Promise.resolve(candidate),
    });

    for await (const _event of streamNoteProposal(
      input('Change noon to one in the note.', false, {
        note: {
          id: 'note',
          title: 'Schedule',
          markdown: 'opens at noon. Version A.',
          revision: 1,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
      assistantMessage,
      model,
      new AbortController().signal,
    )) {
      // consume the stream
    }

    const instructions = mocks.options.mock.calls[0]?.[0].instructions as string;
    expect(instructions).toContain('make only the requested local change');
    expect(instructions).toContain('oldText “noon” and newText “one”');
    expect(instructions).toContain('Do not add unrelated response_takeaway operations');
    // A real exchange captured "When an AI cannot access a URL, a more helpful
    // approach is…" as a note. Commentary on the assistant is never the user's
    // durable material.
    expect(instructions).toContain("The subject of a capture must be the user's own topic");
    expect(instructions).toContain('Never capture a statement about the assistant');
  });

  it('withdraws a streaming preview when the final agent decision declines the edit', async () => {
    const preview = {
      shouldPropose: true,
      captureBasis: 'response_takeaway',
      mode: 'add',
      oldText: '',
      newText: '- A useful durable takeaway.',
      reason: 'Could be useful later.',
    } as const;
    const declined = {
      ...preview,
      shouldPropose: false,
      captureBasis: 'none',
      reason: 'This point is already covered in the note.',
    } as const;
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(preview),
      object: Promise.resolve(declined),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('What should I remember?', false),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([
      {
        type: 'preview',
        proposal: expect.objectContaining({ newText: expect.any(String) }),
        operationIndex: 0,
      },
      { type: 'done', proposal: null, reason: 'This point is already covered in the note.' },
    ]);
  });

  it('streams and completes multiple independent anchored operations', async () => {
    const operations = [
      {
        shouldPropose: true,
        captureBasis: 'user_decision',
        mode: 'replace',
        oldText: 'First decision.',
        newText: 'First decision: ship Friday.',
        reason: 'Records the date.',
      },
      {
        shouldPropose: true,
        captureBasis: 'user_constraint',
        mode: 'replace',
        oldText: 'Second constraint.',
        newText: 'Second constraint: keep rollback available.',
        reason: 'Records the constraint.',
      },
    ] as const;
    const batch = { operations, reason: '' };
    mocks.stream.mockResolvedValue({
      objectStream: objectStream({ operations: [operations[0]] }, batch),
      object: Promise.resolve(batch),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Record both decisions.', true, {
        note: {
          id: 'note',
          title: 'Plan',
          markdown: 'First decision.\n\nSecond constraint.',
          revision: 2,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.filter((event) => event.type === 'preview')).toMatchObject([
      { operationIndex: 0 },
      { operationIndex: 1 },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      proposal: { newText: operations[1].newText },
      proposals: [
        { oldText: operations[0].oldText, newText: operations[0].newText },
        { oldText: operations[1].oldText, newText: operations[1].newText },
      ],
    });
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('Expected done event');
    expect(done.proposals?.[0]?.id).not.toBe(done.proposals?.[1]?.id);
  });

  it('streams three independent additions into an empty note', async () => {
    const items = [
      'The workshop opens at ten.',
      'The workshop closes on Tuesdays.',
      'The courtyard entrance is accessible.',
    ];
    const operations = items.map((newText) => ({
      shouldPropose: true,
      captureBasis: 'explicit_request' as const,
      mode: 'add' as const,
      oldText: '',
      newText,
      reason: 'Records one requested detail.',
    }));
    const batch = { operations };
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(
        { operations: operations.slice(0, 1) },
        { operations: operations.slice(0, 2) },
        batch,
      ),
      object: Promise.resolve(batch),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input(`Add three separate note items: ${items.join(' ')}`, true),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.filter((event) => event.type === 'preview')).toMatchObject([
      { operationIndex: 0, proposal: { newText: items[0] } },
      { operationIndex: 1, proposal: { newText: items[1] } },
      { operationIndex: 2, proposal: { newText: items[2] } },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      proposals: items.map((newText) => ({ newText })),
    });
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('Expected done event');
    expect(new Set(done.proposals?.map(({ id }) => id)).size).toBe(3);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it('returns a contextual no-op for an empty operation batch', async () => {
    const batch = { operations: [], reason: 'The note already covers both points.' };
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(batch),
      object: Promise.resolve(batch),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Propose useful additions.', true),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([
      {
        type: 'done',
        proposal: null,
        proposals: [],
        reason: 'The note already covers both points.',
      },
    ]);
  });

  it('asks once for a contextual reason when an empty batch omits it', async () => {
    const batch = { operations: [] };
    const explanation = { reason: 'That fact is already covered by the current note.' };
    mocks.stream
      .mockResolvedValueOnce({
        objectStream: objectStream(batch),
        object: Promise.resolve(batch),
      })
      .mockResolvedValueOnce({
        objectStream: objectStream(explanation),
        object: Promise.resolve(explanation),
      });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Propose this note again.', true),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      {
        type: 'done',
        proposal: null,
        proposals: [],
        reason: 'That fact is already covered by the current note.',
      },
    ]);
  });

  it('fails a malformed operation batch without emitting an unsafe final edit', async () => {
    const batch = {
      operations: [
        {
          shouldPropose: true,
          captureBasis: 'user_decision',
          oldText: '',
          newText: 'Missing its required mode.',
          reason: 'Malformed.',
        },
      ],
      reason: '',
    };
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(batch),
      object: Promise.resolve(batch),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Save the decision.', true),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([
      {
        type: 'error',
        message: 'The note suggestions could not be completed as concise, safe edits.',
      },
    ]);
  });

  it.each(['message', 'capture'] as const)(
    'reports a provider failure during %s repair instead of blaming the edit',
    async (action) => {
      const candidate = {
        shouldPropose: true,
        captureBasis: 'explicit_request',
        oldText: '',
        newText: 'Missing its required mode.',
        reason: 'Malformed.',
      };
      const initial = action === 'capture' ? candidate : { operations: [candidate] };
      mocks.stream
        .mockResolvedValueOnce({
          objectStream: objectStream(initial),
          object: Promise.resolve(initial),
        })
        .mockRejectedValueOnce(
          new Error('Workers AI API error (429 Too Many Requests): daily free allocation exceeded'),
        );
      const events = [];
      for await (const event of streamNoteProposal(
        input('Save this exact text.', true, { action }),
        assistantMessage,
        model,
        new AbortController().signal,
      ))
        events.push(event);
      expect(events.at(-1)).toEqual({
        type: 'error',
        message:
          'AI replies are unavailable because the provider’s daily allowance has been reached. Try again after it resets.',
      });
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(mocks.stream).toHaveBeenCalledTimes(2);
    },
  );

  it('repairs invalid batch members once while preserving valid sibling indexes', async () => {
    const valid = {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'First decision.',
      newText: 'First decision: ship Friday.',
      reason: 'Records the date.',
    } as const;
    const invalid = { ...valid, oldText: 'Missing anchor.', newText: 'Missing anchor fixed.' };
    const corrected = {
      ...valid,
      captureBasis: 'user_constraint' as const,
      oldText: 'Second constraint.',
      newText: 'Second constraint: keep rollback available.',
      reason: 'Records the constraint.',
    };
    const initialBatch = { operations: [valid, invalid], reason: '' };
    const repairedBatch = { operations: [corrected], reason: '' };
    mocks.stream
      .mockResolvedValueOnce({
        objectStream: objectStream(initialBatch),
        object: Promise.resolve(initialBatch),
      })
      .mockResolvedValueOnce({
        objectStream: objectStream(repairedBatch),
        object: Promise.resolve(repairedBatch),
      });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Record both decisions.', true, {
        note: {
          id: 'note',
          title: 'Plan',
          markdown: 'First decision.\n\nSecond constraint.',
          revision: 2,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(events).toMatchObject([
      { type: 'preview', operationIndex: 0 },
      { type: 'preview', operationIndex: 1 },
      {
        type: 'done',
        proposals: [
          { oldText: 'First decision.', newText: 'First decision: ship Friday.' },
          {
            oldText: 'Second constraint.',
            newText: 'Second constraint: keep rollback available.',
          },
        ],
      },
    ]);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('Expected done event');
    expect(done.proposals?.[0]?.id).not.toBe(done.proposals?.[1]?.id);
  });

  it('turns an already-applied invalid correction into the repair agent contextual no-op', async () => {
    const invalidBatch = {
      operations: [
        {
          shouldPropose: true,
          captureBasis: 'explicit_request',
          mode: 'replace',
          oldText: 'opens at noon',
          newText: 'opens at one',
          reason: 'Updates the opening time.',
        },
      ],
      reason: '',
    } as const;
    const declinedRepair = {
      operations: [],
      reason: 'The note already says the observatory opens at one.',
    } as const;
    mocks.stream
      .mockResolvedValueOnce({
        objectStream: objectStream(invalidBatch),
        object: Promise.resolve(invalidBatch),
      })
      .mockResolvedValueOnce({
        objectStream: objectStream(declinedRepair),
        object: Promise.resolve(declinedRepair),
      });

    const events = [];
    for await (const event of streamNoteProposal(
      input('The observatory opens at one now. Update just the opening time.', true, {
        note: {
          id: 'note',
          title: 'Observatory',
          markdown: 'The fictional observatory opens at one. Version A.',
          revision: 2,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
      {
        ...assistantMessage,
        content: 'The fictional observatory opens at one. Version A.',
      },
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({
      type: 'done',
      proposal: null,
      proposals: [],
      reason: 'The note already says the observatory opens at one.',
    });
  });

  it('keeps valid siblings when repair contextually declines an invalid operation', async () => {
    const valid = {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'Version A.',
      newText: 'Version B.',
      reason: 'Records the selected version.',
    } as const;
    const invalid = {
      ...valid,
      oldText: 'The fictional observatory opens at one. Version A.',
      newText: 'The fictional observatory opens at one. Version A.',
      reason: 'The opening time is already current.',
    };
    const initialBatch = { operations: [valid, invalid], reason: '' };
    const declinedRepair = {
      operations: [],
      reason: 'The opening time is already current.',
    };
    mocks.stream
      .mockResolvedValueOnce({
        objectStream: objectStream(initialBatch),
        object: Promise.resolve(initialBatch),
      })
      .mockResolvedValueOnce({
        objectStream: objectStream(declinedRepair),
        object: Promise.resolve(declinedRepair),
      });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Update the note.', true, {
        note: {
          id: 'note',
          title: 'Observatory',
          markdown: 'The fictional observatory opens at one. Version A.',
          revision: 2,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      proposal: { oldText: 'Version A.', newText: 'Version B.' },
      proposals: [{ oldText: 'Version A.', newText: 'Version B.' }],
    });
  });

  it('honors an explicitly declined batch operation without repairing it', async () => {
    const declined = {
      operations: [
        {
          shouldPropose: false,
          captureBasis: 'user_decision',
          mode: 'replace',
          oldText: 'The fictional observatory opens at one. Version A.',
          newText: 'The fictional observatory opens at one. Version A.',
          reason: 'The note already includes this update.',
        },
      ],
      reason: '',
    } as const;
    mocks.stream.mockResolvedValueOnce({
      objectStream: objectStream(declined),
      object: Promise.resolve(declined),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Update just the opening time.', true, {
        note: {
          id: 'note',
          title: 'Observatory',
          markdown: 'The fictional observatory opens at one. Version A.',
          revision: 2,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({
      type: 'done',
      proposal: null,
      proposals: [],
      reason: 'The note already includes this update.',
    });
  });

  it('preserves valid siblings beside an explicitly declined batch operation', async () => {
    const valid = {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'Version A.',
      newText: 'Version B.',
      reason: 'Records the selected version.',
    } as const;
    const declined = {
      shouldPropose: false,
      captureBasis: 'user_decision',
      mode: 'replace',
      oldText: 'opens at one',
      newText: 'opens at one',
      reason: 'The opening time is already current.',
    } as const;
    const batch = { operations: [valid, declined], reason: '' } as const;
    mocks.stream.mockResolvedValueOnce({
      objectStream: objectStream(batch),
      object: Promise.resolve(batch),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Update the note.', true, {
        note: {
          id: 'note',
          title: 'Observatory',
          markdown: 'The fictional observatory opens at one. Version A.',
          revision: 2,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      proposal: { oldText: 'Version A.', newText: 'Version B.' },
      proposals: [{ oldText: 'Version A.', newText: 'Version B.' }],
    });
  });

  it('streams an explicit user capture after its basis is classified', async () => {
    const candidate = {
      shouldPropose: true,
      captureBasis: 'explicit_request',
      mode: 'add',
      oldText: '',
      newText: '- Rainbows form through refraction, reflection, and dispersion.',
      reason: 'The user asked to save this explanation.',
    } as const;
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(candidate),
      object: Promise.resolve(candidate),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('What makes a rainbow appear? Explain the mechanism in three sentences.', true),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual(['preview', 'done']);
    expect(events.at(-1)).toMatchObject({
      proposal: { newText: candidate.newText, status: 'pending' },
    });
    expect(mocks.stream.mock.calls[0]?.[1].structuredOutput.jsonPromptInjection).toBe(true);
    expect(mocks.primitives).toHaveBeenCalledWith({ logger: expect.anything() });
    expect(mocks.stream.mock.calls[0]?.[0]).toContain('"currentNoteMarkdown":""');
    expect(mocks.stream.mock.calls[0]?.[0]).toContain('"completedAssistantResponse"');
    expect(mocks.stream.mock.calls[0]?.[1]).not.toHaveProperty('context');
    expect(mocks.options.mock.calls[0]?.[0]?.instructions).toContain(
      'Trusted UI note proposal request: yes',
    );
  });

  it('repairs an invalid oversized final before completing the proposal', async () => {
    const preview = {
      shouldPropose: true,
      captureBasis: 'user_insight',
      mode: 'add',
      oldText: '',
      newText: '- Prefer small, reversible trials.',
      reason: 'Captures the user’s takeaway.',
    } as const;
    const final = {
      ...preview,
      newText: Array.from({ length: 51 }, (_, index) => `word${index}`).join(' '),
    };
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(preview, final),
      object: Promise.resolve(final),
    });
    const repaired = {
      ...preview,
      newText: '- Prefer small, reversible trials with clear checks.',
    };
    mocks.stream.mockResolvedValueOnce({
      objectStream: objectStream(preview, final),
      object: Promise.resolve(final),
    });
    mocks.stream.mockResolvedValueOnce({
      objectStream: objectStream(repaired),
      object: Promise.resolve(repaired),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('I have learned that small, reversible trials work best.'),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual(['preview', 'preview', 'done']);
    expect(events.at(-1)).toMatchObject({ proposal: { newText: repaired.newText } });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(mocks.stream.mock.calls[1]?.[0]).toContain(
      'These limits apply even when captureBasis is explicit_request',
    );
    expect(mocks.options.mock.calls.at(-1)?.[0].instructions).toContain(
      'captureBasis explicit_request alone does NOT mean verbatim capture',
    );
  });

  it('allows a selective durable takeaway from an explanatory response', async () => {
    const candidate = {
      shouldPropose: true,
      captureBasis: 'response_takeaway',
      mode: 'add',
      oldText: '',
      newText: '- Rainbows separate colors because wavelengths refract at different angles.',
      reason: 'Keeps the reusable mechanism.',
    } as const;
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(candidate),
      object: Promise.resolve(candidate),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('What makes a rainbow appear?'),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.at(-1)).toMatchObject({ proposal: { newText: candidate.newText } });
  });

  it('frames an existing empty note explicitly without synthetic note headers', async () => {
    const candidate = {
      shouldPropose: true,
      captureBasis: 'user_decision',
      mode: 'add',
      oldText: '',
      newText: '- Use the reversible option.',
      reason: 'Captures the decision.',
    } as const;
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(candidate),
      object: Promise.resolve(candidate),
    });
    const emptyNote = {
      id: 'note-1',
      title: 'Decision',
      markdown: '',
      revision: 1,
      provenance: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    };

    const events = [];
    for await (const event of streamNoteProposal(
      input('I decided to use the reversible option.', false, { note: emptyNote }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.at(-1)).toMatchObject({ proposal: { oldText: '' } });
    const task = String(mocks.stream.mock.calls[0]?.[0]);
    expect(task).toContain('"currentNoteMarkdown":""');
    expect(task).not.toContain('Untrusted current note');
    expect(task).toContain('[Structured extraction task]');
  });

  it('rejects an explicit capture that replaces existing text even if it contains the exact quote', () => {
    const candidate = {
      shouldPropose: true,
      captureBasis: 'explicit_request' as const,
      mode: 'replace' as const,
      oldText: 'Existing text.',
      newText: 'Keep cash.',
      reason: 'Capture',
    };
    expect(
      noteProposalFromCandidate(
        {
          id: 'note',
          title: 'Note',
          markdown: 'Existing text.',
          revision: 1,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
        'turn',
        candidate,
        true,
        { explicitCapture: true, requestedText: 'Keep cash.' },
      ),
    ).toBeNull();
  });

  it('uses the supplied capture verbatim after the model chooses a valid block location', () => {
    const captured =
      'The 30-year yield is a market-driven price for long-term risk, whereas HYSA rates are a commercial price for short-term liquidity.';
    const note = {
      id: 'note',
      title: 'Finance',
      markdown:
        "test test\n\nThe 30-year yield reflects long-term expectations for inflation and economic growth.\n\nA bank's HYSA rate follows its need for liquidity.",
      revision: 1,
      provenance: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    const proposal = noteProposalFromCandidate(
      note,
      'turn',
      {
        shouldPropose: true,
        captureBasis: 'response_takeaway',
        mode: 'add',
        oldText: '',
        newText: 'A paraphrase the model should not control.',
        reason: 'Captures the selected comparison.',
      },
      true,
      { explicitCapture: true, requestedText: captured },
    );

    expect(proposal).toMatchObject({ oldText: '', newText: captured });
  });

  it('rejects a generated insertion that invents a Markdown heading', () => {
    const anchor = 'Bond prices fall when market yields rise.';
    const candidate = {
      shouldPropose: true,
      captureBasis: 'response_takeaway' as const,
      mode: 'replace' as const,
      oldText: anchor,
      newText: `## Bonds\n\n${anchor}\n- Long yields reflect inflation expectations and the term premium.`,
      reason: 'Adds the takeaway.',
    };
    expect(
      noteProposalFromCandidate(
        {
          id: 'note',
          title: 'Finance',
          markdown: `# Bonds\n${anchor}`,
          revision: 1,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
        'turn',
        candidate,
        true,
      ),
    ).toBeNull();
  });

  it('accepts an exact replacement when the model carries an unused block id', () => {
    const note = {
      id: 'note',
      title: 'Library',
      markdown: '- The imaginary library has a blue front door.',
      revision: 1,
      provenance: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    expect(
      noteProposalFromCandidate(
        note,
        'turn',
        {
          shouldPropose: true,
          captureBasis: 'user_decision',
          mode: 'replace',
          oldText: 'The imaginary library has a blue front door.',
          newText: 'The imaginary library has a green front door.',
          reason: 'Corrects the door color.',
        },
        true,
      ),
    ).toMatchObject({
      oldText: 'The imaginary library has a blue front door.',
      newText: 'The imaginary library has a green front door.',
    });
  });

  it('allows a concise insertion after an unchanged existing heading', () => {
    const candidate = {
      shouldPropose: true,
      captureBasis: 'response_takeaway' as const,
      mode: 'add' as const,
      oldText: '',
      newText: '- Long yields reflect inflation expectations and the term premium.',
      reason: 'Adds the takeaway under the existing section.',
    };
    expect(
      noteProposalFromCandidate(
        {
          id: 'note',
          title: 'Finance',
          markdown: '# Bonds\nBond prices fall when market yields rise.',
          revision: 1,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
        'turn',
        candidate,
        true,
      ),
    ).toMatchObject({
      oldText: '',
      newText: '- Long yields reflect inflation expectations and the term premium.',
    });
  });

  it('trims model whitespace around a generated addition before placing it', () => {
    const proposal = noteProposalFromCandidate(
      {
        id: 'note',
        title: 'Finance',
        markdown: 'Existing fact.',
        revision: 1,
        provenance: [],
        createdAt: 'now',
        updatedAt: 'now',
      },
      'turn',
      {
        shouldPropose: true,
        captureBasis: 'response_takeaway',
        mode: 'add',
        oldText: '',
        newText: '\n\n- Added fact.\n\n',
        reason: 'Adds a durable fact.',
      },
      true,
    );

    expect(proposal).toMatchObject({
      oldText: '',
      newText: '- Added fact.',
    });
  });

  it('rejects replacement output that echoes another complete note block', () => {
    const bank =
      "A bank's HYSA rate is not a mathematical function of the Treasury yield; it follows the bank's need for liquidity.";
    expect(
      noteProposalFromCandidate(
        {
          id: 'note',
          title: 'Finance',
          markdown: `test test\n\n${bank}`,
          revision: 1,
          provenance: [],
          createdAt: 'now',
          updatedAt: 'now',
        },
        'turn',
        {
          shouldPropose: true,
          captureBasis: 'response_takeaway',
          mode: 'replace',
          oldText: bank,
          newText: `test test\n\n${bank}\n\n- Long yields reflect inflation expectations and the term premium.`,
          reason: 'Adds the takeaway.',
        },
        true,
      ),
    ).toBeNull();
  });

  it('streams an addition only after its block location and text are valid', async () => {
    const note = {
      id: 'note',
      title: 'Finance',
      markdown: '# Bonds\nBond prices fall when yields rise.',
      revision: 1,
      provenance: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    const located = {
      shouldPropose: true,
      captureBasis: 'response_takeaway',
      mode: 'add',
      oldText: '',
    } as const;
    const complete = {
      ...located,
      newText: '- Long yields reflect inflation expectations and the term premium.',
      reason: 'Adds the durable distinction.',
    };
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(located, complete),
      object: Promise.resolve(complete),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Why do long yields differ from savings rates?', false, { note }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual(['preview', 'done']);
    expect(events.at(-1)).toMatchObject({
      // An addition is its text. Where it lands is computed from the note
      // wherever the edit is applied, never stored on the proposal.
      proposal: { oldText: '', newText: complete.newText },
    });
  });

  it('streams known capture text as soon as the model supplies a valid location', async () => {
    const captured = 'Small reversible trials reveal risk early.';
    const note = {
      id: 'note',
      title: 'Experiments',
      markdown: 'Existing principle.',
      revision: 1,
      provenance: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    const located = {
      shouldPropose: true,
      captureBasis: 'explicit_request',
      mode: 'add',
    } as const;
    const complete = {
      ...located,
      oldText: '',
      newText: 'Model text is ignored for trusted capture.',
      reason: 'Captures the selection.',
    };
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(located, complete),
      object: Promise.resolve(complete),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input(captured, false, { action: 'capture', note }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual(['preview', 'preview', 'done']);
    expect(events[0]).toMatchObject({
      proposal: {
        id: expect.any(String),
        oldText: '',
        newText: captured,
      },
    });
    expect(events.at(-1)).toMatchObject({
      proposal: {
        oldText: '',
        newText: captured,
      },
    });
    expect(
      new Set(events.flatMap((event) => ('proposal' in event ? [event.proposal?.id] : []))).size,
    ).toBe(1);
  });

  it('uses unique neighboring context for an addition to a repeated block', () => {
    // Placement picks the later of two identical blocks, so the anchor has to
    // widen to the preceding block to identify it unambiguously.
    const markdown = 'Intro\n\nVendor risk\n\nMiddle\n\nVendor risk\n\nEnd';
    const proposal = noteProposalFromCandidate(
      {
        id: 'note',
        title: 'Repeated',
        markdown,
        revision: 1,
        provenance: [],
        createdAt: 'now',
        updatedAt: 'now',
      },
      'turn',
      {
        shouldPropose: true,
        captureBasis: 'user_insight',
        mode: 'add',
        oldText: '',
        newText: '- Vendor risk reviewed monthly.',
        reason: 'Adds the insight.',
      },
      true,
    );
    expect(proposal).toMatchObject({
      oldText: '',
      newText: '- Vendor risk reviewed monthly.',
    });
  });

  it('restores the exact capture text when the model paraphrases it', async () => {
    const captured = 'Small reversible trials reveal risk early.';
    const note = {
      id: 'note-1',
      ownerId: 'owner-1',
      title: 'Experiments',
      markdown: '- Existing principle.',
      revision: 3,
      provenance: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    };
    const invalid = {
      shouldPropose: true,
      captureBasis: 'explicit_request',
      mode: 'add',
      oldText: '',
      newText: '- Reversible experiments expose problems sooner.',
      reason: 'Captures the selected text.',
    } as const;
    mocks.stream.mockResolvedValueOnce({
      objectStream: objectStream(invalid),
      object: Promise.resolve(invalid),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input(captured, false, { action: 'capture', note }),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([
      {
        type: 'preview',
        proposal: expect.objectContaining({ oldText: '', newText: captured }),
      },
      {
        type: 'done',
        proposal: expect.objectContaining({ oldText: '', newText: captured }),
      },
    ]);
    // An explicit capture inserts the user's own words, so a paraphrase is
    // substituted away rather than sent back to the model to be repaired.
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it('uses the repaired agent reason when repair deliberately declines the edit', async () => {
    const invalid = {
      shouldPropose: true,
      captureBasis: 'user_insight',
      mode: 'add',
      oldText: '',
      newText: 'A'.repeat(401),
      reason: 'Initial candidate looked useful.',
    } as const;
    const declined = {
      ...invalid,
      shouldPropose: false,
      captureBasis: 'none',
      newText: '',
      reason: 'The note already covers this point.',
    } as const;
    mocks.stream
      .mockResolvedValueOnce({
        objectStream: objectStream(invalid),
        object: Promise.resolve(invalid),
      })
      .mockResolvedValueOnce({
        objectStream: objectStream(declined),
        object: Promise.resolve(declined),
      });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Remember this detail.'),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([
      { type: 'done', proposal: null, reason: 'The note already covers this point.' },
    ]);
  });

  it('declines cleanly when the structured stream resolves with no object', async () => {
    // A truncated or unparseable generation resolves the object as undefined.
    // Dereferencing it threw a TypeError that surfaced as "Note proposal
    // generation failed" — the app looking broken instead of simply declining.
    mocks.stream.mockResolvedValue({
      objectStream: objectStream(),
      object: Promise.resolve(undefined),
    });

    const events = [];
    for await (const event of streamNoteProposal(
      input('Tell me about rainbows'),
      assistantMessage,
      model,
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([{ type: 'done', proposal: null, reason: undefined }]);
  });
});
