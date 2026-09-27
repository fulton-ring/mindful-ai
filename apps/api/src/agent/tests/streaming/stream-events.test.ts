import { describe, expect, it } from 'vitest';
import { isLengthLimitedFinalChunk } from '../../stream-events';

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
