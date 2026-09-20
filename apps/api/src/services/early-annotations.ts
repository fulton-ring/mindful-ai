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
  const output: ChatEvent[] = [];
  const finalized: Annotation[] = [];
  let wake: (() => void) | undefined;
  let fullText = '';
  let coveredUpTo = 0;
  let running: Promise<void> | undefined;
  let allSucceeded = true;
  let primaryDone = false;
  let pumpFailure: unknown;
  let doneEvent: Extract<ChatEvent, { type: 'done' }> | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const queue = (event: ChatEvent) => {
    output.push(event);
    notify();
  };
  const budgetReached = () => finalized.length >= annotationBudget(fullText);

  /** Classify one segment. `final` drops the boundary requirement. */
  const runWindow = (segment: string, final: boolean) => {
    coveredUpTo += segment.length;
    running = (async () => {
      try {
        const events = await classify(segment, annotationController.signal);
        let reachedDone = false;
        for await (const event of events) {
          if (event.type === 'annotation') {
            finalized.push(event.annotation);
            queue(event);
          }
          if (event.type === 'done') {
            reachedDone = true;
            finalized.push(...event.annotations);
          }
        }
        if (!reachedDone) allSucceeded = false;
      } catch {
        allSucceeded = false;
      } finally {
        running = undefined;
        notify();
        if (!final) startWindow();
      }
    })();
  };

  const startWindow = () => {
    if (running || annotationController.signal.aborted) return;
    // Nothing more is wanted once the response has earned its full budget.
    if (budgetReached()) {
      coveredUpTo = fullText.length;
      return;
    }
    const remaining = fullText.slice(coveredUpTo);
    const boundary = completedBoundary(remaining);
    if (!boundary) return;
    runWindow(remaining.slice(0, boundary), false);
  };

  const pump = (async () => {
    try {
      for (;;) {
        const next = await primaryIterator.next();
        if (next.done) break;
        const event = next.value;
        if (event.type === 'done') doneEvent = event;
        else {
          if (event.type === 'text') {
            fullText += event.text;
            startWindow();
          }
          queue(event);
        }
      }
    } catch (error) {
      pumpFailure = error;
    } finally {
      primaryDone = true;
      notify();
    }
  })();
  try {
    while (!primaryDone || output.length) {
      while (output.length) yield output.shift()!;
      if (!primaryDone && !output.length) await new Promise<void>((resolve) => (wake = resolve));
    }
    const settle = async () => {
      if (!running) return true;
      return Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), FINAL_WAIT_MS)),
      ]);
    };
    // A window that misses the deadline is a failure: mark it before aborting,
    // because the aborted window's own catch may not run before we report.
    const deadline = () => {
      allSucceeded = false;
      annotationController.abort('annotation completion deadline exceeded');
    };
    if (!(await settle())) deadline();
    // The text is complete, so the tail no longer needs a sentence boundary to
    // be worth classifying. Covering it here is what lets the client skip its
    // post-completion sweep entirely.
    if (!annotationController.signal.aborted && !budgetReached() && coveredUpTo < fullText.length) {
      runWindow(fullText.slice(coveredUpTo), true);
      if (!(await settle())) deadline();
    }
    while (output.length) yield output.shift()!;
    await pump;
    if (pumpFailure) throw pumpFailure;
    if (doneEvent) {
      const annotations = mergeAnnotationsPreservingExisting([], finalized, fullText);
      yield {
        ...doneEvent,
        annotationsHandled: allSucceeded && coveredUpTo >= fullText.length,
        message: { ...doneEvent.message, annotations },
      };
    }
  } finally {
    annotationController.abort('annotation stream closed');
    wake?.();
    signal?.removeEventListener('abort', abort);
    void primaryIterator.return?.().catch(() => {});
    void pump;
    void running?.catch(() => {});
  }
}
