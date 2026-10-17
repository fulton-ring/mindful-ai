import { Worker } from 'node:worker_threads';
import { MAX_ATTACHMENT_BYTES } from '../../../chat/attachments/attachments';
import type {
  DocumentExtraction,
  DocumentExtractionInput,
  DocumentExtractor,
} from '../../../storage/document-extractor';
export type NodeDocumentExtractorOptions = {
  workerUrl?: URL;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxQueued?: number;
};
/** Short-lived workers isolate parsers, bound memory and make cancellation interrupt CPU work. */
export function createNodeDocumentExtractor(
  options: NodeDocumentExtractorOptions = {},
): DocumentExtractor {
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxQueued = options.maxQueued ?? 8;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    !Number.isInteger(maxQueued) ||
    maxQueued < 0 ||
    timeoutMs < 1
  )
    throw new Error('Invalid document worker limits.');
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async extract(input: DocumentExtractionInput): Promise<DocumentExtraction> {
      input.signal?.throwIfAborted();
      if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
        throw new Error('Documents must be between 1 byte and 1 MB.');
      if (active >= maxConcurrent) {
        if (queue.length >= maxQueued)
          throw new Error('Document extraction is busy. Try again shortly.');
        await new Promise<void>((resolve, reject) => {
          const start = () => {
            input.signal?.removeEventListener('abort', abort);
            resolve();
          };
          const abort = () => {
            const index = queue.indexOf(start);
            if (index >= 0) queue.splice(index, 1);
            reject(input.signal?.reason ?? new Error('Document extraction aborted.'));
          };
          queue.push(start);
          input.signal?.addEventListener('abort', abort, { once: true });
        });
      } else active++;
      try {
        input.signal?.throwIfAborted();
        return await runWorker(input, options);
      } finally {
        const next = queue.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

function runWorker(
  input: DocumentExtractionInput,
  options: NodeDocumentExtractorOptions,
): Promise<DocumentExtraction> {
  return new Promise<DocumentExtraction>((resolve, reject) => {
    const worker = new Worker(options.workerUrl ?? new URL('./worker.js', import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    let finished = false;
    const finish = (error?: unknown, result?: DocumentExtraction) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => (error ? reject(error) : resolve(result!)));
    };
    const abort = () => finish(input.signal?.reason ?? new Error('Document extraction aborted.'));
    const timer = setTimeout(
      () => finish(new Error('Document extraction timed out.')),
      options.timeoutMs ?? 30_000,
    );
    input.signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { result?: DocumentExtraction; error?: string }) =>
      message.error
        ? finish(new Error(message.error))
        : message.result && typeof message.result.markdown === 'string'
          ? finish(undefined, message.result)
          : finish(new Error('Invalid document worker response.')),
    );
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!finished) finish(new Error(`Document worker exited (${code}).`));
    });
    worker.postMessage({ name: input.name, mimeType: input.mimeType, bytes: input.bytes });
  });
}
