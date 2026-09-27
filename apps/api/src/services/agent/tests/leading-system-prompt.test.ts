import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { leadingSystemPrompt } from '../leading-system-prompt';

const user = (text: string) =>
  ({
    role: 'user',
    content: [{ type: 'text', text }],
  }) as const satisfies LanguageModelV3Prompt[number];

describe('leading system prompt', () => {
  it('merges every system message into one at the start, keeping the rest in order', () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'Persona' },
      user('First'),
      { role: 'system', content: 'Note context' },
      user('Second'),
    ];
    expect(leadingSystemPrompt(prompt)).toEqual([
      { role: 'system', content: 'Persona\n\nNote context' },
      user('First'),
      user('Second'),
    ]);
  });

  it('leaves a prompt that already has one leading system message, or none, untouched', () => {
    const single: LanguageModelV3Prompt = [{ role: 'system', content: 'Persona' }, user('Hi')];
    const none: LanguageModelV3Prompt = [user('Hi')];
    expect(leadingSystemPrompt(single)).toBe(single);
    expect(leadingSystemPrompt(none)).toBe(none);
  });

  it('moves a lone late system message to the start', () => {
    expect(leadingSystemPrompt([user('Hi'), { role: 'system', content: 'Memory' }])).toEqual([
      { role: 'system', content: 'Memory' },
      user('Hi'),
    ]);
  });
});
