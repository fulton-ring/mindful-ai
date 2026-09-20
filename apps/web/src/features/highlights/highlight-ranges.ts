import type { MessageHighlight } from '@walden/contracts';

/** Newer persisted edits win; null ranges remain reserved tombstones. */
export function effectiveHighlights(highlights: readonly MessageHighlight[]): MessageHighlight[] {
  const reserved: Array<{ start: number; end: number }> = [];
  const result: MessageHighlight[] = [];
  for (const highlight of [...highlights].reverse()) {
    if (reserved.some((range) => highlight.start < range.end && highlight.end > range.start))
      continue;
    reserved.push(highlight);
    if (highlight.color !== null) result.push(highlight);
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}
