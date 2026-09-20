import { describe, expect, it } from 'vitest';
import { contextualActionRequest, contextualActions } from './contextual-actions';

describe('contextual actions', () => {
  it.each([
    ['fact', ['Dig deeper', 'Check evidence', 'Add to note']],
    ['claim', ['Check evidence', 'Challenge', 'Add to note']],
    ['assumption', ['Test assumption', 'Explore alternatives', 'Add to note']],
    ['question', ['Explore question', 'Rephrase', 'Add to note']],
    ['decision', ['Weigh trade-offs', 'Plan next steps', 'Add to note']],
    ['explanation', ['Simplify', 'Give an example', 'Add to note']],
    [undefined, ['Dig deeper', 'Challenge', 'Add to note']],
  ] as const)('returns the intended %s menu', (kind, labels) => {
    expect(contextualActions(kind).map((action) => action.label)).toEqual(labels);
  });

  it('routes evidence checks without implying external verification', () => {
    expect(contextualActionRequest('check_evidence', 'Ice floats.')).toEqual({
      intent: 'message',
      prompt:
        'Examine what supports this statement and its limits. If no sources are available, say so rather than implying verification: “Ice floats.”',
    });
  });

  it('routes challenge separately and rejects unknown actions', () => {
    expect(contextualActionRequest('challenge', 'Ice floats.')).toEqual({
      intent: 'challenge',
      prompt: 'Challenge: “Ice floats.”',
    });
    expect(contextualActionRequest('unknown', 'Ice floats.')).toBeNull();
  });

  it.each([
    ['deeper', 'Dive deeper', 'message'],
    ['test_assumption', 'make it hold or fail', 'message'],
    ['explore_alternatives', 'credible alternatives', 'message'],
    ['explore_question', 'question and its implications', 'message'],
    ['rephrase', 'Rephrase this question', 'message'],
    ['weigh_tradeoffs', 'trade-offs', 'message'],
    ['plan_next_steps', 'practical next steps', 'message'],
    ['simplify', 'more simply', 'message'],
    ['give_example', 'concrete example', 'message'],
  ] as const)('builds the %s prompt with the intended message intent', (action, phrase, intent) => {
    const request = contextualActionRequest(action, 'Selected text');
    expect(request?.prompt).toContain(phrase);
    expect(request?.prompt).toContain('“Selected text”');
    expect(request?.intent).toBe(intent);
  });
});
