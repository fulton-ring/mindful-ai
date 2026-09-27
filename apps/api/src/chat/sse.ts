const encoder = new TextEncoder();

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

export const encodeSse = (event: unknown, id?: number) =>
  encoder.encode(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`);

export const sseResponse = (body: BodyInit) => new Response(body, { headers: SSE_HEADERS });

/**
 * Streams events from work that keeps running in `waitUntil` after the response
 * starts. A client disconnect aborts the work; a failure that wasn't an abort
 * is reported as `errorEvent`.
 */
export function createBackgroundSseStream<Event>(options: {
  requestSignal: AbortSignal;
  waitUntil(task: Promise<unknown>): void;
  errorEvent: Event;
  run(signal: AbortSignal, emit: (event: Event) => boolean): Promise<void>;
  cleanup?(): Promise<void>;
}): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const abort = () => controller.abort('client disconnected');
  options.requestSignal.addEventListener('abort', abort, { once: true });
  if (options.requestSignal.aborted) abort();
  return new ReadableStream<Uint8Array>({
    start(output) {
      const emit = (event: Event) => {
        try {
          output.enqueue(encodeSse(event));
          return true;
        } catch {
          controller.abort('response stream closed');
          return false;
        }
      };
      const run = async () => {
        try {
          await options.run(controller.signal, emit);
        } catch {
          if (!controller.signal.aborted) emit(options.errorEvent);
        } finally {
          await options.cleanup?.();
          options.requestSignal.removeEventListener('abort', abort);
          try {
            output.close();
          } catch {
            /* Reader already left. */
          }
        }
      };
      options.waitUntil(run());
    },
    cancel: abort,
  });
}
