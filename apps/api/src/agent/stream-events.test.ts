import { describe, expect, it } from 'vitest';
import { isLengthLimitedFinalChunk, visibleStreamEvent } from './index';

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
