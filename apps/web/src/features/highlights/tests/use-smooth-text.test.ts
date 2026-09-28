// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { advanceReveal, initialReveal, revealedText, useSmoothText } from '../use-smooth-text';

/** Simulates 60 fps frames while text arrives in bursts; returns chars revealed per frame. */
function simulate(bursts: { at: number; chars: number }[], endAt: number, until: number) {
  let state = initialReveal(0, 0);
  let length = 0;
  const steps: number[] = [];
  for (let now = 0; now <= until; now += 1000 / 60) {
    for (const burst of bursts)
      if (burst.at <= now && burst.at > now - 1000 / 60) length += burst.chars;
    const before = state.position;
    state = advanceReveal(state, length, now < endAt, now, 1 / 60);
    steps.push(state.position - before);
  }
  return { steps, state, length };
}

describe('smooth text reveal', () => {
  it('reveals bursty chunks at a steady pace, without jumping when a chunk lands', () => {
    // 60 characters every 500 ms: 120 chars/s, arriving in lumps.
    const bursts = Array.from({ length: 20 }, (_, i) => ({ at: i * 500, chars: 60 }));
    const { steps } = simulate(bursts, 10_000, 9_000);
    const steady = steps.slice(120, 540);
    expect(Math.max(...steady)).toBeLessThan(5);
    expect(Math.min(...steady)).toBeGreaterThan(0.5);
  });

  it('finishes the rest shortly after the reply completes', () => {
    const bursts = Array.from({ length: 10 }, (_, i) => ({ at: i * 300, chars: 80 }));
    const { state, length } = simulate(bursts, 3_000, 6_000);
    expect(state.position).toBe(length);
  });

  it('cuts the revealed text at a word boundary', () => {
    expect(revealedText('Tides rise twice', 8)).toBe('Tides');
    expect(revealedText('Tides rise\ntwice', 12)).toBe('Tides rise');
    expect(revealedText('Tides', 99)).toBe('Tides');
  });
});

describe('useSmoothText', () => {
  it('shows a finished reply at once', () => {
    const { result } = renderHook(() => useSmoothText('A saved reply.', false));
    expect(result.current).toEqual({ text: 'A saved reply.', revealing: false });
  });

  it('still reveals text that lands in the same update that ends the stream', async () => {
    const reply = 'Barnacles cement themselves high on the rocks where predators cannot reach.';
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothText(text, streaming),
      {
        initialProps: { text: '', streaming: true },
      },
    );
    rerender({ text: reply, streaming: false });
    expect(result.current.revealing).toBe(true);
    expect(result.current.text).not.toBe(reply);
    await waitFor(() => expect(result.current).toEqual({ text: reply, revealing: false }), {
      timeout: 4_000,
    });
  });
});
