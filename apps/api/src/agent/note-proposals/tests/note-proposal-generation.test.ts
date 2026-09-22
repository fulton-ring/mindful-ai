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

import { noteProposalBatchOutputSchema, streamNoteProposal } from '../../index';
import { assistantMessage, input, model, objectStream } from '../note-proposal-generation-fixtures';

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
