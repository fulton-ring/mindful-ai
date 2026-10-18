import { MAX_DOCUMENT_INPUT_BYTES } from '../../../storage/document-extractor';

export function validateDocumentInput(bytes: Uint8Array): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error('Documents must be between 1 byte and the 32 MB parser input safety limit.');
}
