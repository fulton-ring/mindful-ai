import type { Annotation } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { annotationBudget, mergeAnnotationsPreservingExisting } from '../early-annotations';

const mark = (quote: string): Annotation => ({
  id: quote,
  quote,
  kind: 'fact',
  whose: 'assistant',
});

describe('annotationBudget', () => {
  it('keeps a floor for short replies', () => {
    expect(annotationBudget('Ready.')).toBe(3);
    expect(annotationBudget('x'.repeat(800))).toBe(3);
  });

  it('scales with the length of a long reply', () => {
    expect(annotationBudget('x'.repeat(2000))).toBe(5);
    expect(annotationBudget('x'.repeat(4000))).toBe(10);
  });

  it('caps so one pass cannot wash out the whole response', () => {
    expect(annotationBudget('x'.repeat(100_000))).toBe(12);
  });
});

describe('mergeAnnotationsPreservingExisting', () => {
  // Each sentence is a distinct, unambiguous quote in the source text.
  const sentences = Array.from(
    { length: 24 },
    (_, index) =>
      `Sentence number ${index} carries enough distinct wording to stand alone as an unambiguous quote inside this reply.`,
  );
  const text = sentences.join(' ');

  it('admits more than the old fixed cap of four on a long reply', () => {
    const merged = mergeAnnotationsPreservingExisting([], sentences.map(mark), text);
    expect(merged.length).toBe(annotationBudget(text));
    expect(merged.length).toBeGreaterThan(4);
  });

  it('still preserves existing marks ahead of new ones', () => {
    const existing = [mark(sentences[23]!)];
    const merged = mergeAnnotationsPreservingExisting(existing, sentences.map(mark), text);
    expect(merged[0]?.quote).toBe(sentences[23]);
  });

  it('honours an explicit budget', () => {
    const merged = mergeAnnotationsPreservingExisting([], sentences.map(mark), text, 2);
    expect(merged).toHaveLength(2);
  });
});
