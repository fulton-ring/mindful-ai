import { expect, it } from 'vitest';
import { annotationKindSchema, semanticAnnotations } from '../index';

it('only generates the six supported semantic kinds', () => {
  for (const activeKind of ['fact', 'claim', 'assumption', 'question', 'decision', 'explanation']) {
    expect(annotationKindSchema.safeParse(activeKind).success).toBe(true);
  }
  for (const retiredKind of ['reasoning', 'number', 'source']) {
    expect(annotationKindSchema.safeParse(retiredKind).success).toBe(false);
  }
});

it('keeps exact assistant quotes, removes duplicates, and limits the result', () => {
  const text = 'The estimate is 42. Is that assumption sound?';
  const candidates = [
    { quote: 'The estimate is 42.', kind: 'claim' as const, worthHighlighting: true },
    { quote: 'The estimate is 42.', kind: 'claim' as const, worthHighlighting: true },
    { quote: 'missing quote', kind: 'fact' as const, worthHighlighting: true },
    { quote: 'Is that assumption sound?', kind: 'question' as const, worthHighlighting: true },
    ...Array.from({ length: 10 }, (_, index) => ({
      quote: '42',
      kind: index % 2 ? ('claim' as const) : ('fact' as const),
      worthHighlighting: true,
    })),
  ];

  expect(semanticAnnotations(candidates, text, 'turn')).toEqual([
    { id: expect.any(String), quote: 'The estimate is 42.', kind: 'claim', whose: 'assistant' },
    {
      id: expect.any(String),
      quote: 'Is that assumption sound?',
      kind: 'question',
      whose: 'assistant',
    },
  ]);
});

it('keeps substantive fixtures sparse and rejects administrative or full-answer selections', () => {
  // Marks must not accumulate into a wash across a long passage, while the
  // first substantive mark in a short one still lands.
  const longPassage = Array.from(
    { length: 6 },
    (_, index) =>
      `Sentence ${index} carries a distinct substantive claim that is worth returning to later on.`,
  ).join(' ');
  const washed = semanticAnnotations(
    longPassage
      .split('. ')
      .filter(Boolean)
      .map((sentence) => ({
        quote: sentence.endsWith('.') ? sentence : `${sentence}.`,
        kind: 'claim' as const,
        worthHighlighting: true,
      })),
    longPassage,
    'turn',
  );
  const covered = washed.reduce((total, item) => total + item.quote.length, 0);
  expect(washed.length).toBeGreaterThan(0);
  expect(covered / longPassage.length).toBeLessThan(0.45);

  const administrative =
    'I prepared the note update for you. The rollout will use the smaller deployment because it limits first-release risk. Review the details before accepting the change.';
  expect(
    semanticAnnotations(
      [
        {
          quote: 'I prepared the note update for you.',
          kind: 'decision',
          worthHighlighting: false,
        },
        {
          quote:
            'The rollout will use the smaller deployment because it limits first-release risk.',
          kind: 'decision',
          worthHighlighting: true,
        },
        { quote: administrative, kind: 'explanation', worthHighlighting: true },
      ],
      administrative,
      'turn',
    ),
  ).toEqual([
    expect.objectContaining({
      quote: 'The rollout will use the smaller deployment because it limits first-release risk.',
      kind: 'decision',
    }),
  ]);
});

it('allows a concise answer to be highlighted when the whole statement is substantive', () => {
  const text = 'Use the smaller deployment for the first release.';
  expect(
    semanticAnnotations([{ quote: text, kind: 'decision', worthHighlighting: true }], text, 'turn'),
  ).toHaveLength(1);
});
