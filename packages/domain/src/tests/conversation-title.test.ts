import { describe, expect, it } from 'vitest';
import { conversationTitle } from '../conversation-title';

describe('conversationTitle', () => {
  it('drops length directives and trailing instructions', () => {
    expect(
      conversationTitle(
        'Explain in about 400 words why bridges have expansion joints, covering thermal expansion, materials, and failure modes. Do not propose a note.',
      ),
    ).toBe('Explain why bridges have expansion joints, covering thermal…');
  });

  it('keeps the user’s own wording for a short decision', () => {
    expect(
      conversationTitle(
        'We decided the retro moves to Thursdays and Sam will own the agenda. Please record that in my note.',
      ),
    ).toBe('We decided the retro moves to Thursdays and Sam will own…');
  });

  it('removes a conversational lead-in', () => {
    expect(conversationTitle('Can you explain how tides work?')).toBe('Explain how tides work?');
  });

  it('never cuts mid-word', () => {
    const source =
      'Compare the maintenance characteristics of suspension bridges against cable stayed bridges';
    const title = conversationTitle(source);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(62);
    // Every kept word must be whole: the body is followed by a space in the
    // original, never by more letters of the same word.
    const body = title.slice(0, -1);
    const rest = source.slice(body.length);
    expect(rest.startsWith(' ')).toBe(true);
  });

  it('falls back rather than returning nothing when the prompt is all instruction', () => {
    expect(conversationTitle('Please reply with exactly: ready.')).not.toBe('');
    expect(conversationTitle('   ')).toBe('New thread');
  });

  it('leaves an already-short subject alone apart from capitalisation', () => {
    expect(conversationTitle('tides and the moon')).toBe('Tides and the moon');
  });
});
