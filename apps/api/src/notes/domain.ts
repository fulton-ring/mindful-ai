import type { ProvenanceSpan } from '@walden/contracts';
import { HttpError } from '../http';

export function assertValidProvenance(markdown: string, provenance: ProvenanceSpan[]): void {
  let previousEnd = 0;
  for (const span of [...provenance].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (span.from > span.to || span.to > markdown.length)
      throw new HttpError(400, 'Invalid provenance range');
    if (span.from < previousEnd) throw new HttpError(400, 'Provenance spans overlap');
    if (span.origin === 'user' && span.verbatim)
      throw new HttpError(400, 'User provenance cannot be verbatim agent text');
    previousEnd = span.to;
  }
}

export const normalizeTitle = (title: string) => title.trim() || 'Untitled note';
