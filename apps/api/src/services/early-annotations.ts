import type { Annotation, AnnotationEvent, ChatEvent } from '@walden/contracts';

/**
 * How many highlights a response of this length may carry. A fixed cap of four
 * left long answers barely marked while short ones were saturated, so scale
 * with the text and keep an upper bound so a single pass cannot wash out the
 * whole response.
 */
export function annotationBudget(text: string): number {
  return Math.min(12, Math.max(3, Math.round(text.length / 400)));
}

const MIN_EARLY_CHARS = 120;
const MAX_EARLY_CHARS = 1_200;
const FINAL_WAIT_MS = 2_000;

type DoneEvent = Extract<ChatEvent, { type: 'done' }>;

type AnnotationStreamState = {
  output: ChatEvent[];
  finalized: Annotation[];
  wake?: () => void;
  fullText: string;
  coveredUpTo: number;
  running?: Promise<void>;
  allSucceeded: boolean;
  primaryDone: boolean;
  pumpFailure?: unknown;
  doneEvent?: DoneEvent;
};

function completedBoundary(text: string) {
  let boundary = 0;
  for (const match of text.matchAll(/(?:\n\s*\n|[.!?]["')\]]?(?=\s|$))/gu)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end <= MAX_EARLY_CHARS) boundary = end;
  }
  return boundary >= MIN_EARLY_CHARS ? boundary : 0;
}

export function mergeAnnotationsPreservingExisting(
  existing: Annotation[],
  additions: Annotation[],
  text: string,
  budget = annotationBudget(text),
): Annotation[] {
  const result: Annotation[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const annotation of [...existing, ...additions]) {
    const start = text.indexOf(annotation.quote);
    const end = start + annotation.quote.length;
    if (
      start < 0 ||
      text.indexOf(annotation.quote, start + 1) >= 0 ||
      seen.has(annotation.quote) ||
      occupied.some((range) => start < range.end && end > range.start)
    )
      continue;
    seen.add(annotation.quote);
    occupied.push({ start, end });
    result.push(annotation);
    if (result.length >= budget) break;
  }
  return result;
}

function createAnnotationStreamState(): AnnotationStreamState {
  return {
    output: [],
    finalized: [],
    fullText: '',
    coveredUpTo: 0,
    allSucceeded: true,
    primaryDone: false,
  };
}

function notify(state: AnnotationStreamState) {
  state.wake?.();
  state.wake = undefined;
}

function queueEvent(state: AnnotationStreamState, event: ChatEvent) {
  state.output.push(event);
  notify(state);
}

async function consumeWindowEvents(
  state: AnnotationStreamState,
  events: AsyncIterable<AnnotationEvent>,
) {
  let reachedDone = false;
  for await (const event of events) {
    if (event.type === 'annotation') {
      state.finalized.push(event.annotation);
      queueEvent(state, event);
    }
    if (event.type === 'done') {
      reachedDone = true;
      state.finalized.push(...event.annotations);
    }
  }
  return reachedDone;
}

function createWindowController(
  state: AnnotationStreamState,
  classify: (text: string, signal: AbortSignal) => Promise<AsyncIterable<AnnotationEvent>>,
  annotationSignal: AbortSignal,
) {
  let startWindow = () => {};
  const budgetReached = () => state.finalized.length >= annotationBudget(state.fullText);
  const runWindow = (segment: string, final: boolean) => {
    state.coveredUpTo += segment.length;
    state.running = (async () => {
      try {
        const events = await classify(segment, annotationSignal);
        const reachedDone = await consumeWindowEvents(state, events);
        if (!reachedDone) state.allSucceeded = false;
      } catch {
        state.allSucceeded = false;
      } finally {
        state.running = undefined;
        notify(state);
        if (!final) startWindow();
      }
    })();
  };
  startWindow = () => {
    if (state.running || annotationSignal.aborted) return;
    if (budgetReached()) {
      state.coveredUpTo = state.fullText.length;
      return;
    }
    const remaining = state.fullText.slice(state.coveredUpTo);
    const boundary = completedBoundary(remaining);
    if (!boundary) return;
    runWindow(remaining.slice(0, boundary), false);
  };
  return { budgetReached, runWindow, startWindow };
}

async function pumpPrimary(
  primaryIterator: AsyncIterator<ChatEvent>,
  state: AnnotationStreamState,
  startWindow: () => void,
) {
  try {
    for (;;) {
      const next = await primaryIterator.next();
      if (next.done) break;
      const event = next.value;
      if (event.type === 'done') state.doneEvent = event;
      else {
        if (event.type === 'text') {
          state.fullText += event.text;
          startWindow();
        }
        queueEvent(state, event);
      }
    }
  } catch (error) {
    state.pumpFailure = error;
  } finally {
    state.primaryDone = true;
    notify(state);
  }
}

async function* emitPrimaryOutput(state: AnnotationStreamState): AsyncIterable<ChatEvent> {
  while (!state.primaryDone || state.output.length) {
    while (state.output.length) yield state.output.shift()!;
    if (!state.primaryDone && !state.output.length)
      await new Promise<void>((resolve) => (state.wake = resolve));
  }
}

function* drainOutput(state: AnnotationStreamState): Iterable<ChatEvent> {
  while (state.output.length) yield state.output.shift()!;
}

async function settleRunning(state: AnnotationStreamState): Promise<boolean> {
  if (!state.running) return true;
  return Promise.race([
    state.running.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), FINAL_WAIT_MS)),
  ]);
}

async function finishAnnotations(
  state: AnnotationStreamState,
  annotationController: AbortController,
  windows: ReturnType<typeof createWindowController>,
) {
  const deadline = () => {
    state.allSucceeded = false;
    annotationController.abort('annotation completion deadline exceeded');
  };
  if (!(await settleRunning(state))) deadline();
  if (
    !annotationController.signal.aborted &&
    !windows.budgetReached() &&
    state.coveredUpTo < state.fullText.length
  ) {
    windows.runWindow(state.fullText.slice(state.coveredUpTo), true);
    if (!(await settleRunning(state))) deadline();
  }
}

/**
 * Classify the response in successive windows as it streams, rather than once
 * over the opening portion. A single early pass covered only the first window
 * no matter how long the answer, so every long reply finished, paused, and then
 * popped in the rest of its highlights from a second round trip. Windowing
 * keeps marks arriving with the text and usually leaves nothing for the client
 * to sweep up afterwards.
 */
export async function* streamWithEarlyAnnotations(
  primary: AsyncIterable<ChatEvent>,
  classify: (text: string, signal: AbortSignal) => Promise<AsyncIterable<AnnotationEvent>>,
  signal?: AbortSignal,
): AsyncIterable<ChatEvent> {
  const annotationController = new AbortController();
  const abort = () => annotationController.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const primaryIterator = primary[Symbol.asyncIterator]();
  const state = createAnnotationStreamState();
  const windows = createWindowController(state, classify, annotationController.signal);
  const pump = pumpPrimary(primaryIterator, state, windows.startWindow);
  try {
    yield* emitPrimaryOutput(state);
    await finishAnnotations(state, annotationController, windows);
    yield* drainOutput(state);
    await pump;
    if (state.pumpFailure) throw state.pumpFailure;
    if (state.doneEvent) {
      const annotations = mergeAnnotationsPreservingExisting(
        [],
        state.finalized,
        state.doneEvent.message.content,
      );
      yield {
        ...state.doneEvent,
        annotationsHandled: state.allSucceeded && state.coveredUpTo >= state.fullText.length,
        message: { ...state.doneEvent.message, annotations },
      };
    }
  } finally {
    annotationController.abort('annotation stream closed');
    state.wake?.();
    signal?.removeEventListener('abort', abort);
    void primaryIterator.return?.().catch(() => {});
    void pump;
    void state.running?.catch(() => {});
  }
}
