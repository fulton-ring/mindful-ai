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

import { noteProposalFromCandidate, streamNoteProposal } from '../../index';
import { assistantMessage, input, model, objectStream } from '../note-proposal-generation-fixtures';

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.options.mockReset();
  mocks.primitives.mockReset();
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
