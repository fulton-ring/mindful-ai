import { describe, expect, it } from 'vitest';
import { conversationStreamingDisposition, turnReplayDisposition } from './routes';

describe('turn replay recovery', () => {
  it('keeps a recent persisted turn active even when another isolate owns it', () => {
    expect(
      turnReplayDisposition(
        'streaming',
        false,
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:01:00.000Z'),
      ),
    ).toBe('active');
  });

  it('recovers a persisted turn older than the generation deadline and grace period', () => {
    expect(
      turnReplayDisposition(
        'streaming',
        false,
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:01:31.000Z'),
      ),
    ).toBe('recover');
  });

  it('allows a new request to recover a stale conversation-level streaming lock', () => {
    expect(
      conversationStreamingDisposition(
        false,
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:02:00.000Z'),
      ),
    ).toBe('recover');
  });

  it('keeps a streaming turn active when its controller exists locally', () => {
    expect(
      turnReplayDisposition(
        'streaming',
        true,
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:03:00.000Z'),
      ),
    ).toBe('active');
  });

  it('replays terminal turns', () => {
    expect(
      turnReplayDisposition(
        'completed',
        false,
        '2026-09-18T12:00:00.000Z',
        Date.parse('2026-09-18T12:03:00.000Z'),
      ),
    ).toBe('replay');
  });
});
