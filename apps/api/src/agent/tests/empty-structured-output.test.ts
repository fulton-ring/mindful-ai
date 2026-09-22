import { describe, expect, it } from 'vitest';
import { annotationOutputSchema, noteProposalBatchOutputSchema } from '../index';

// Gemma expresses "nothing to report" by omitting the array rather than
// returning an empty one. Both generators are allowed to decline, so an omitted
// array has to parse as a decline; when it did not, the reader saw
// "Highlights could not be generated" and "Note proposal generation failed"
// for responses the models had correctly decided to leave alone.
describe('declining is a valid structured output', () => {
  it('reads an omitted annotations array as no highlights', () => {
    expect(annotationOutputSchema.parse({})).toEqual({ annotations: [] });
  });

  it('reads an omitted operations array as no proposal', () => {
    expect(noteProposalBatchOutputSchema.parse({})).toEqual({ operations: [] });
  });

  it('keeps the reason a decline carries with it', () => {
    expect(noteProposalBatchOutputSchema.parse({ reason: 'Already in the note.' })).toEqual({
      operations: [],
      reason: 'Already in the note.',
    });
  });

  it('still rejects a malformed array rather than silently dropping it', () => {
    expect(() => annotationOutputSchema.parse({ annotations: 'none' })).toThrow();
    expect(() => noteProposalBatchOutputSchema.parse({ operations: {} })).toThrow();
  });
});
