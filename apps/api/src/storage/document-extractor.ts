export type DocumentExtractionInput = {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
};
export type DocumentExtraction = { markdown: string; tokens?: number };
export interface DocumentExtractor {
  extract(input: DocumentExtractionInput): Promise<DocumentExtraction>;
}
/** Cloudflare's optional extraction capability stays behind the same portable contract. */
export function createCloudflareDocumentExtractor(ai: {
  toMarkdown(input: {
    name: string;
    blob: Blob;
  }): Promise<{ format: string; data?: string; tokens?: number }>;
}): DocumentExtractor {
  return {
    async extract(input) {
      input.signal?.throwIfAborted();
      const result = await ai.toMarkdown({
        name: input.name,
        blob: new Blob([input.bytes], { type: input.mimeType }),
      });
      input.signal?.throwIfAborted();
      if (result.format === 'error' || !result.data)
        throw new Error(`Could not extract text from "${input.name}".`);
      return { markdown: result.data, tokens: result.tokens };
    },
  };
}
