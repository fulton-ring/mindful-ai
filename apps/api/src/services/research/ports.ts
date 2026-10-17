/** Research indexes contain retrieved public pages only, never private documents. */
export interface ResearchBrowser {
  readMarkdown(url: string, signal: AbortSignal): Promise<string>;
  listVisibleLinks(url: string, signal: AbortSignal): Promise<string[]>;
  screenshot(
    url: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: 'image/jpeg' }>;
}
export type SourceInput = { ownerScope: string; url: string; markdown: string };
export type IndexingResult = { id?: string; status: string; reason?: string };
export interface SavedSources {
  upsert(source: SourceInput, signal: AbortSignal): Promise<IndexingResult>;
  search(
    ownerScope: string,
    query: string,
    signal: AbortSignal,
  ): Promise<{ query: string; results: Array<{ url: string; text: string; score: number }> }>;
  deleteOwner(ownerScope: string): Promise<void>;
}
