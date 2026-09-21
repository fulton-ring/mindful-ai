import { describe, expect, it } from 'vitest';
import {
  GemmaToolLeakDecoder,
  isLengthLimitedFinalChunk,
  recoveredFrontendIntervention,
  visibleStreamEvent,
} from './index';

describe('stream finish classification', () => {
  it('classifies a final length finish as incomplete', () => {
    expect(
      isLengthLimitedFinalChunk({ type: 'finish', payload: { stepResult: { reason: 'length' } } }),
    ).toBe(true);
  });

  it('classifies a non-continuing length-limited step as incomplete', () => {
    expect(
      isLengthLimitedFinalChunk({
        type: 'step-finish',
        payload: { stepResult: { reason: 'length', isContinued: false } },
      }),
    ).toBe(true);
  });

  it('does not classify a normal stop as incomplete', () => {
    expect(
      isLengthLimitedFinalChunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } }),
    ).toBe(false);
  });

  it('does not classify a tool continuation as incomplete', () => {
    expect(
      isLengthLimitedFinalChunk({
        type: 'step-finish',
        payload: { stepResult: { reason: 'length', isContinued: true } },
      }),
    ).toBe(false);
  });
});

describe('visibleStreamEvent', () => {
  it('keeps model reasoning separate from answer text', () => {
    expect(
      visibleStreamEvent({ type: 'reasoning-delta', payload: { text: 'Check assumptions.' } }),
    ).toEqual({
      type: 'reasoning',
      text: 'Check assumptions.',
    });
    expect(
      visibleStreamEvent({ type: 'text-delta', payload: { text: 'Here is the answer.' } }),
    ).toEqual({
      type: 'text',
      text: 'Here is the answer.',
    });
  });

  it('does not manufacture reasoning from other chunks', () => {
    expect(visibleStreamEvent({ type: 'finish', payload: {} })).toBeNull();
  });
});

describe('GemmaToolLeakDecoder', () => {
  const leaked =
    'proposeAsk{options:[<|"|>Focus on the \'common driver\' mechanism<|"|>,<|"|>Focus on the conditions for decoupling<|"|>,<|"|>Focus on the lag between instruments<|"|>,<|"|>Other<|"|>],question:<|"|>Which aspect of the challenge best serves your current thinking?<|"|>}';

  it('recovers the leaked Gemma tool syntax without exposing it as text', () => {
    const decoder = new GemmaToolLeakDecoder();
    const result = decoder.push(leaked);

    expect(result.text).toBe('');
    expect(result.calls).toEqual([
      {
        name: 'proposeAsk',
        input: {
          question: 'Which aspect of the challenge best serves your current thinking?',
          options: [
            "Focus on the 'common driver' mechanism",
            'Focus on the conditions for decoupling',
            'Focus on the lag between instruments',
            'Other',
          ],
        },
      },
    ]);
    expect(decoder.finish()).toBe('');
  });

  it('handles one-character chunks while preserving prose around a recovered call', () => {
    const decoder = new GemmaToolLeakDecoder();
    let text = '';
    const calls = [];
    for (const character of `Before. ${leaked} After.`) {
      const result = decoder.push(character);
      text += result.text;
      calls.push(...result.calls);
    }
    text += decoder.finish();

    expect(text).toBe('Before.  After.');
    expect(calls).toHaveLength(1);
  });

  it('does not swallow ordinary prose that only resembles a tool call', () => {
    const decoder = new GemmaToolLeakDecoder();
    const prose = 'The literal string proposeAsk{not a valid call} can appear in documentation.';
    const result = decoder.push(prose);

    expect(result.text + decoder.finish()).toBe(prose);
    expect(result.calls).toEqual([]);
  });

  it('recovers a multiple-choice learning check with required choices', () => {
    const decoder = new GemmaToolLeakDecoder();
    const result = decoder.push(
      'proposeLearningCheck{question:<|"|>What shared driver affects both measures?<|"|>,options:[<|"|>Demand<|"|>,<|"|>Timing<|"|>]}',
    );

    expect(result.calls).toEqual([
      {
        name: 'proposeLearningCheck',
        input: {
          question: 'What shared driver affects both measures?',
          options: ['Demand', 'Timing'],
        },
      },
    ]);
    const call = result.calls[0];
    if (!call) throw new Error('Expected a recovered call');
    expect(recoveredFrontendIntervention(call, 'turn', false)).toBeNull();
    expect(recoveredFrontendIntervention(call, 'turn', true)).toMatchObject({
      kind: 'learning_check',
      questions: [
        {
          format: 'multiple_choice',
          question: 'What shared driver affects both measures?',
        },
      ],
    });
  });

  it('recovers a short-answer check and rejects invalid choice counts', () => {
    const decoder = new GemmaToolLeakDecoder();
    expect(
      decoder.push('proposeLearningCheck{question:<|"|>Where is the stroma?<|"|>}').calls,
    ).toEqual([
      {
        name: 'proposeLearningCheck',
        input: { question: 'Where is the stroma?' },
      },
    ]);
    for (const input of [
      'question:<|"|>Where?<|"|>,options:[<|"|>A<|"|>]',
      'question:<|"|>Where?<|"|>,options:[]',
    ]) {
      expect(new GemmaToolLeakDecoder().push(`proposeLearningCheck{${input}}`).calls).toEqual([]);
    }
  });
});
