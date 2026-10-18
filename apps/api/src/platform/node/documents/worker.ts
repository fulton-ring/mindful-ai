import { parentPort } from 'node:worker_threads';
import type { DocumentExtractionInput } from '../../../storage/document-extractor';
import { convertDocument } from './convert';

parentPort?.once('message', async (input: DocumentExtractionInput) => {
  try {
    parentPort!.postMessage({ result: await convertDocument(input) });
  } catch (error) {
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : 'Document extraction failed.',
    });
  }
});
