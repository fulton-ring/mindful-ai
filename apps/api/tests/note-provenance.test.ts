import { describe, expect, it } from 'vitest';
import { assertValidProvenance } from '../src/notes/save-note';

describe('note provenance', () => {
  it('rejects provenance outside the saved markdown', () => {
    expect(() =>
      assertValidProvenance('hello', [{ from: 0, to: 6, origin: 'user', verbatim: false }]),
    ).toThrow('provenance range');
  });

  it('rejects overlapping provenance spans', () => {
    expect(() =>
      assertValidProvenance('hello', [
        { from: 0, to: 3, origin: 'user', verbatim: false },
        { from: 2, to: 5, origin: 'agent', verbatim: true },
      ]),
    ).toThrow('overlap');
  });
});
