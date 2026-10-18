import { expect, it } from 'vitest';
import { createNodeDocumentExtractor } from './extractor';

const input = {
  name: 'paper.pdf',
  mimeType: 'application/pdf',
  bytes: new TextEncoder().encode('%PDF-'),
};
const hangingWorker = new URL(
  'data:text/javascript,import {parentPort} from "node:worker_threads"; parentPort.on("message",()=>{});',
);
it('allows accepted larger documents while enforcing a separate parser safety bound', async () => {
  const workerUrl = new URL(
    'data:text/javascript,import {parentPort} from "node:worker_threads"; parentPort.on("message",input=>parentPort.postMessage({result:{markdown:String(input.bytes.length)}}));',
  );
  const extractor = createNodeDocumentExtractor({ workerUrl });
  expect(await extractor.extract({ ...input, bytes: new Uint8Array(1_000_001) })).toEqual({
    markdown: '1000001',
  });
  await expect(extractor.extract({ ...input, bytes: new Uint8Array(32_000_001) })).rejects.toThrow(
    '32 MB',
  );
});
it('terminates timed out extraction and frees bounded worker capacity', async () => {
  const extractor = createNodeDocumentExtractor({
    workerUrl: hangingWorker,
    timeoutMs: 25,
    maxConcurrent: 1,
    maxQueued: 0,
  });
  const pending = extractor.extract(input);
  await expect(extractor.extract(input)).rejects.toThrow('busy');
  await expect(pending).rejects.toThrow('timed out');
  await expect(extractor.extract(input)).rejects.toThrow('timed out');
});
it('cancels a running worker and rejects pre-cancelled work', async () => {
  const extractor = createNodeDocumentExtractor({ workerUrl: hangingWorker, timeoutMs: 1000 });
  const controller = new AbortController();
  const pending = extractor.extract({ ...input, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow('abort');
  await expect(extractor.extract({ ...input, signal: controller.signal })).rejects.toThrow('abort');
});
