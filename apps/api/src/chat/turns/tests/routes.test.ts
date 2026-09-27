import { describe, expect, it } from 'vitest';
import { turnReplayDisposition } from '../turn-support';

describe('durable turn replay disposition', () => {
  it('keeps an admitted turn active regardless of its age', () => {
    expect(turnReplayDisposition('streaming')).toBe('active');
  });

  it('replays terminal turns and blocks failed requests from restarting', () => {
    expect(turnReplayDisposition('completed')).toBe('replay');
    expect(turnReplayDisposition('cancelled')).toBe('replay');
    expect(turnReplayDisposition('failed')).toBe('blocked');
  });
});
