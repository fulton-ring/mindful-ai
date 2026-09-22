import { describe, expect, it } from 'vitest';
import { normalizeLearningCheck, recoveredFrontendIntervention } from '../learning-checks';

const call = {
  name: 'proposeLearningCheck' as const,
  input: {
    questions: [
      {
        id: 'anodizing_layer',
        header: 'Anodizing',
        question: 'What does anodizing thicken?',
      },
      {
        id: 'surface_result',
        header: 'Result',
        question: 'Which surface changes?',
        options: ['The oxide layer', 'The metal core'],
      },
    ],
  },
};

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
      questions: [
        { id: 'anodizing_layer', format: 'short_answer' },
        { id: 'surface_result', format: 'multiple_choice' },
      ],
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

describe('learning-check normalization', () => {
  it('normalizes mixed question batches into durable learning checks', () => {
    expect(
      normalizeLearningCheck(
        {
          questions: [
            { question: 'Which layer changes?', options: ['Oxide', 'Core'] },
            { question: 'Why does the layer matter?' },
          ],
        },
        'turn-1',
      ),
    ).toMatchObject({
      kind: 'learning_check',
      questions: [
        { format: 'multiple_choice', id: 'question_1' },
        { format: 'short_answer', id: 'question_2' },
      ],
    });
  });
});
