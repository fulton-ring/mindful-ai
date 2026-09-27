import type { Annotation } from '@walden/contracts';

/**
 * How many highlights a response of this length may carry. A fixed cap of four
 * left long answers barely marked while short ones were saturated, so scale
 * with the text and keep an upper bound so a single pass cannot wash out the
 * whole response.
 */
export function annotationBudget(text: string): number {
  return Math.min(12, Math.max(3, Math.round(text.length / 400)));
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
