import type { Annotation, AnnotationEvent, ChatEvent } from '@walden/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { streamWithEarlyAnnotations } from '../early-annotations';

const text =
  'A rainbow appears when sunlight enters a raindrop and separates into wavelengths. Internal reflection redirects that separated light toward the observer.';
const annotation: Annotation = {
  id: 'annotation-1',
  quote: 'sunlight enters a raindrop',
  kind: 'explanation',
  whose: 'assistant',
};
const done = (content: string): ChatEvent => ({
  type: 'done',
  message: {
    id: 'assistant-1',
    role: 'assistant',
    content,
    createdAt: '2026-09-18T12:00:00.000Z',
  },
  conversationId: 'conversation-1',
  branchId: 'branch-1',
  title: 'Rainbow',
  expiresAt: '2999-01-01T00:00:00.000Z',
});

async function collect(stream: AsyncIterable<ChatEvent>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => vi.useRealTimers());
it('emits a classification before the primary stream finishes', async () => {
  let finishPrimary!: () => void;
  const primaryGate = new Promise<void>((resolve) => {
    finishPrimary = resolve;
  });
  const primary = (async function* () {
    yield { type: 'text', text } as const;
    await primaryGate;
    yield done(text);
  })();
  const classify = async () =>
    (async function* (): AsyncIterable<AnnotationEvent> {
      yield { type: 'annotation', annotation };
      yield { type: 'done', annotations: [annotation] };
    })();
  const iterator = streamWithEarlyAnnotations(primary, classify)[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: { type: 'text', text },
  });
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: { type: 'annotation', annotation },
  });
  finishPrimary();
  const rest: ChatEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    rest.push(next.value);
  }
  expect(rest.at(-1)).toMatchObject({
    type: 'done',
    annotationsHandled: true,
    message: { annotations: [annotation] },
  });
});

it('keeps primary text successful when classification ends without a terminal result', async () => {
  const primary = (async function* () {
    yield { type: 'text', text } as const;
    yield done(text);
  })();
  const events = await collect(
    streamWithEarlyAnnotations(primary, async () =>
      (async function* (): AsyncIterable<AnnotationEvent> {
        yield { type: 'annotation', annotation };
      })(),
    ),
  );

  expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  expect(events.at(-1)).toMatchObject({
    type: 'done',
    annotationsHandled: false,
    message: { content: text, annotations: [annotation] },
  });
});

it('shares cancellation with an in-flight classifier', async () => {
  const controller = new AbortController();
  let classifierSignal: AbortSignal | undefined;
  const primary = (async function* () {
    yield { type: 'text', text } as const;
    await new Promise((resolve) => setTimeout(resolve, 1));
    yield done(text);
  })();
  const eventsPromise = collect(
    streamWithEarlyAnnotations(
      primary,
      async (_batch, signal) => {
        classifierSignal = signal;
        return (async function* (): AsyncIterable<AnnotationEvent> {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          if (signal.aborted) throw new Error('cancelled');
        })();
      },
      controller.signal,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort('cancelled');
  await eventsPromise;

  expect(classifierSignal?.aborted).toBe(true);
});

it('propagates a primary stream failure without an unhandled pump rejection', async () => {
  const failure = new Error('primary failed');
  const primary = (async function* () {
    yield { type: 'text', text } as const;
    throw failure;
  })();

  await expect(
    collect(
      streamWithEarlyAnnotations(primary, async () =>
        (async function* (): AsyncIterable<AnnotationEvent> {
          yield { type: 'done', annotations: [] };
        })(),
      ),
    ),
  ).rejects.toBe(failure);
});

it('aborts secondary work when its consumer stops reading', async () => {
  let classifierSignal: AbortSignal | undefined;
  const primary = (async function* () {
    yield { type: 'text', text } as const;
    await new Promise(() => {});
  })();
  const iterator = streamWithEarlyAnnotations(primary, async (_batch, signal) => {
    classifierSignal = signal;
    return (async function* (): AsyncIterable<AnnotationEvent> {
      yield { type: 'annotation', annotation };
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    })();
  })[Symbol.asyncIterator]();

  await iterator.next();
  await iterator.next();
  await iterator.return?.();

  expect(classifierSignal?.aborted).toBe(true);
});

it('keeps validated streamed annotations when the terminal object misses the deadline', async () => {
  vi.useFakeTimers();
  const primary = (async function* () {
    yield { type: 'text', text } as const;
    yield done(text);
  })();
  const result = collect(
    streamWithEarlyAnnotations(primary, async (_batch, signal) =>
      (async function* (): AsyncIterable<AnnotationEvent> {
        yield { type: 'annotation', annotation };
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      })(),
    ),
  );
  await vi.advanceTimersByTimeAsync(2_000);

  await expect(result).resolves.toEqual([
    { type: 'text', text },
    { type: 'annotation', annotation },
    expect.objectContaining({
      type: 'done',
      annotationsHandled: false,
      message: expect.objectContaining({ annotations: [annotation] }),
    }),
  ]);
});

it('does not attach provisional annotations when the final visible reply is empty', async () => {
  const primary = (async function* () {
    yield { type: 'text', text } as const;
    yield done('');
  })();
  const events = await collect(
    streamWithEarlyAnnotations(primary, async () =>
      (async function* (): AsyncIterable<AnnotationEvent> {
        yield { type: 'annotation', annotation };
        yield { type: 'done', annotations: [annotation] };
      })(),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: 'done', message: { annotations: [] } });
});
