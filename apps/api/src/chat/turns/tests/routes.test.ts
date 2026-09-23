import { describe, expect, it } from 'vitest';
import { conversationStreamingDisposition, turnReplayDisposition } from '../routes';

describe('turn replay recovery', () => {
  it('keeps a four-minute turn active even when another isolate owns it', () => {
    expect(
      turnReplayDisposition(
        'streaming',
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:04:00.000Z'),
      ),
    ).toBe('active');
  });

  it('recovers a persisted turn older than the generation deadline and grace period', () => {
    expect(
      turnReplayDisposition(
        'streaming',
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:05:16.000Z'),
      ),
    ).toBe('recover');
  });

  it('allows a new request to recover a stale conversation-level streaming lock', () => {
    expect(
      conversationStreamingDisposition(
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:06:00.000Z'),
      ),
    ).toBe('recover');
  });

  it('recovers an expired turn even when hard termination left its local controller behind', () => {
    expect(
      turnReplayDisposition(
        'streaming',
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:06:00.000Z'),
      ),
    ).toBe('recover');
  });

  it('replays terminal turns', () => {
    expect(
      turnReplayDisposition(
        'completed',
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:06:00.000Z'),
      ),
    ).toBe('replay');
  });
});
