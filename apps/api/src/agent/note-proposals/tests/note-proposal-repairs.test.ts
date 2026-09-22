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

import { streamNoteProposal } from '../../index';
import { assistantMessage, input, model, objectStream } from '../note-proposal-generation-fixtures';

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.options.mockReset();
  mocks.primitives.mockReset();
});

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
