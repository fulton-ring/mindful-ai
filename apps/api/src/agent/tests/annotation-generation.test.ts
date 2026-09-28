import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), options: vi.fn() }));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    stream = mocks.stream;
    __registerPrimitives() {}
  },
}));

import {
  AnnotationGenerationError,
  annotateResponse,
  streamAnnotationResponse,
} from '../stream-events';

const model = {} as Parameters<typeof annotateResponse>[0]['model'];
const signal = () => new AbortController().signal;
function objectStream(...values: unknown[]) {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

beforeEach(() => {
  mocks.stream.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it('emits complete exact-quote classifications before the final object resolves', async () => {
  let resolveFinal!: (value: unknown) => void;
  const final = new Promise((resolve) => {
    resolveFinal = resolve;
  });
  mocks.stream.mockResolvedValue({
    objectStream: objectStream(
      { annotations: [{ quote: 'smaller', kind: 'decision', worthHighlighting: true }] },
      {
        annotations: [
          { quote: 'smaller deployment', kind: 'decision', worthHighlighting: true },
          { quote: 'Use', kind: 'fact', worthHighlighting: true },
        ],
      },
    ),
    object: final,
  });
  const iterator = streamAnnotationResponse({
    text: 'Use the smaller deployment.',
    turnId: 'turn-1',
    model,
    signal: signal(),
    conversationId: 'c-1',
  })[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: {
      type: 'annotation',
      annotation: expect.objectContaining({ quote: 'smaller deployment', kind: 'decision' }),
    },
  });
  resolveFinal({
    annotations: [{ quote: 'smaller deployment', kind: 'decision', worthHighlighting: true }],
  });
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: {
      type: 'done',
      annotations: [expect.objectContaining({ quote: 'smaller deployment', kind: 'decision' })],
    },
  });
});

it('deduplicates partial annotations and omits quotes absent from the response', async () => {
  const candidate = { quote: 'Ordinary prose.', kind: 'fact', worthHighlighting: true };
  mocks.stream.mockResolvedValue({
    objectStream: objectStream(
      { annotations: [candidate] },
      {
        annotations: [candidate, { quote: 'invented', kind: 'claim', worthHighlighting: true }],
      },
    ),
    object: Promise.resolve({ annotations: [candidate] }),
  });
  const result = [];
  for await (const event of streamAnnotationResponse({
    text: 'Ordinary prose.',
    turnId: 'turn-1',
    model,
    signal: signal(),
    conversationId: 'c-1',
  }))
    result.push(event);
  expect(result.map((event) => event.type)).toEqual(['annotation', 'done']);
  expect(result.filter((event) => event.type === 'annotation')).toHaveLength(1);
});

it('preserves a valid empty classification for the JSON compatibility path', async () => {
  mocks.stream.mockResolvedValue({
    objectStream: objectStream({ annotations: [] }),
    object: Promise.resolve({ annotations: [] }),
  });
  await expect(
    annotateResponse({
      text: 'Ordinary prose.',
      turnId: 'turn-1',
      model,
      signal: signal(),
      conversationId: 'c-1',
    }),
  ).resolves.toEqual([]);
  const options = mocks.stream.mock.calls[0]?.[1];
  expect(options.modelSettings.maxOutputTokens).toBe(2_400);
  const candidates = (length: number) =>
    Array.from({ length }, () => ({
      quote: 'bounded',
      kind: 'fact',
      worthHighlighting: true,
    }));
  // Limits are applied per candidate afterwards: an extra or over-long candidate
  // must not fail validation of the whole batch.
  const schema = options.structuredOutput.schema;
  expect(schema.safeParse({ annotations: candidates(13) }).success).toBe(true);
  expect(
    schema.safeParse({
      annotations: [{ quote: 'x'.repeat(250), kind: 'fact', worthHighlighting: true }],
    }).success,
  ).toBe(true);
});

it('surfaces structured-output failure as an error event and compatibility error', async () => {
  mocks.stream.mockRejectedValue(new Error('structured output was truncated'));
  const streamed = [];
  for await (const event of streamAnnotationResponse({
    text: 'A meaningful claim.',
    turnId: 'turn-1',
    model,
    signal: signal(),
    conversationId: 'c-1',
  }))
    streamed.push(event);
  expect(streamed).toEqual([
    { type: 'error', message: 'Highlights could not be generated. Please try again.' },
  ]);
  await expect(
    annotateResponse({
      text: 'A meaningful claim.',
      turnId: 'turn-1',
      model,
      signal: signal(),
      conversationId: 'c-1',
    }),
  ).rejects.toBeInstanceOf(AnnotationGenerationError);
});

it('reports a provider allowance failure without exposing its payload', async () => {
  mocks.stream.mockRejectedValue(
    new Error('Workers AI API error (429 Too Many Requests): daily free allocation exceeded'),
  );
  const events = [];
  for await (const event of streamAnnotationResponse({
    text: 'Ice floats.',
    turnId: 'turn',
    model,
    signal: signal(),
    conversationId: 'thread',
  }))
    events.push(event);
  expect(events).toEqual([
    {
      type: 'error',
      message:
        'AI replies are unavailable because the provider’s daily allowance has been reached. Try again after it resets.',
    },
  ]);
});

it('propagates cancellation without emitting an error event', async () => {
  const controller = new AbortController();
  controller.abort('cancelled');
  mocks.stream.mockRejectedValue(controller.signal.reason);
  await expect(
    streamAnnotationResponse({
      text: 'A meaningful claim.',
      turnId: 'turn-1',
      model,
      signal: controller.signal,
      conversationId: 'c-1',
    })
      [Symbol.asyncIterator]()
      .next(),
  ).rejects.toBe('cancelled');
});
describe('annotation discernment', () => {
  it('excludes the assistant\u2019s own capabilities and requests to the reader', async () => {
    mocks.stream.mockResolvedValue({
      objectStream: objectStream({ annotations: [] }),
      object: Promise.resolve({ annotations: [] }),
    });
    await annotateResponse({
      text: 'Ordinary prose.',
      turnId: 'turn-1',
      model,
      signal: signal(),
      conversationId: 'c-1',
    });
    const instructions = mocks.options.mock.calls.at(-1)?.[0].instructions as string;
    // A real exchange highlighted "If you can copy and paste the text here, I
    // will summarize it for you." - a request to the reader, not substance.
    expect(instructions).toContain("statements about the assistant's own capabilities");
    expect(instructions).toContain('requests directed at the reader');
  });
});
