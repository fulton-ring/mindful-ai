import { personaSchema } from '@walden/contracts';
import { expect, it } from 'vitest';

it('accepts an operator configured model while preserving persona validation', () => {
  const persona = {
    id: 'local',
    name: 'Local model',
    prompt: '',
    model: 'local/my-thinking-model',
    brevity: 'brief',
    challenge: 'balanced',
    tone: 'neutral',
  };
  expect(personaSchema.safeParse(persona).success).toBe(true);
  expect(personaSchema.safeParse({ ...persona, model: '' }).success).toBe(false);
  expect(personaSchema.safeParse({ ...persona, model: 'x'.repeat(501) }).success).toBe(false);
});
