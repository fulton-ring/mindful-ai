import { describe, expect, it } from 'vitest';
import { recoveredFrontendIntervention } from './index';

const call = {
  name: 'proposeLearningCheck',
  input: { question: 'What does anodizing thicken?' },
} as const;

// Whether a check is warranted is a judgement the model makes from the prompt;
// there is deliberately no heuristic here trying to guess it from the user's
// wording. The one thing the application still decides is the user's explicit
// off-switch, which must hold regardless of what the model asks for.
describe('the learning-check off switch', () => {
  it('drops a check the model proposed after the user turned checks off', () => {
    expect(recoveredFrontendIntervention(call, 'turn', false)).toBeNull();
  });

  it('passes the check through while checks are on', () => {
    expect(recoveredFrontendIntervention(call, 'turn', true)).toMatchObject({
      kind: 'learning_check',
      question: call.input.question,
    });
  });

  it('never suppresses a plain ask, which is not a quiz', () => {
    const ask = {
      name: 'proposeAsk' as const,
      input: { question: 'Which draft should I edit?', options: ['First', 'Second'] },
    };
    expect(recoveredFrontendIntervention(ask, 'turn', false)).toMatchObject({ kind: 'ask' });
  });
});
