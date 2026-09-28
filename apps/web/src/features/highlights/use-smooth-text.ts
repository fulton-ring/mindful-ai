import { useEffect, useRef, useState } from 'react';

/** Seconds of text kept buffered, so a pause in the model does not stall the reveal. */
const LAG_S = 0.8;
/** Seconds over which the reveal speed eases toward its target; no sudden rushes. */
const EASE_S = 0.6;
/** Once the reply is complete, what is left is revealed within about this long. */
const FINISH_S = 2;
const MIN_CPS = 20;

export type RevealState = {
  /** Fractional characters revealed. */
  position: number;
  /** Current reveal speed, characters per second. */
  speed: number;
  /** When the first text arrived (ms) and how much there was then. */
  startedAt: number;
  startLength: number;
};

export const initialReveal = (now: number, length: number): RevealState => ({
  position: 0,
  speed: 0,
  startedAt: now,
  startLength: length,
});

/**
 * Advances the reveal by `dt` seconds. The target speed is the stream's average
 * arrival rate, nudged up or down to keep about `LAG_S` of text in reserve, and
 * the actual speed eases toward it, so bursty chunks read as a steady flow.
 */
export function advanceReveal(
  state: RevealState,
  length: number,
  streaming: boolean,
  now: number,
  dt: number,
): RevealState {
  const backlog = Math.max(0, length - state.position);
  if (backlog === 0) return { ...state, position: length };
  const elapsed = Math.max((now - state.startedAt) / 1000, 0.25);
  const arrival = Math.max(MIN_CPS, (length - state.startLength) / elapsed);
  const target = streaming
    ? arrival * Math.min(1.8, Math.max(0.6, backlog / (arrival * LAG_S)))
    : Math.max(arrival, backlog / FINISH_S);
  const speed = state.speed + (target - state.speed) * Math.min(1, dt / EASE_S);
  return { ...state, speed, position: Math.min(length, state.position + speed * dt) };
}

/** The revealed prefix, ending on a word boundary so whole words fade in. */
export function revealedText(text: string, position: number) {
  if (position >= text.length) return text;
  let cut = Math.floor(position);
  while (cut > 0 && !/\s/.test(text[cut]!)) cut -= 1;
  return text.slice(0, cut);
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

/**
 * Streamed text, revealed at a steady pace instead of in model-sized jumps. Text
 * that was already complete when first shown is returned as is. `revealing` stays
 * true until the reveal catches up with the finished text.
 */
export function useSmoothText(text: string, streaming: boolean) {
  const reveal = useRef<RevealState | null>(null);
  const shownRef = useRef('');
  // Set while this message streams, and kept until the reveal catches up: the
  // last text often lands in the same update that ends the stream.
  const following = useRef(streaming);
  if (streaming) following.current = true;
  const latest = useRef({ text, streaming });
  latest.current = { text, streaming };
  const [shown, setShown] = useState(() => (streaming ? '' : text));
  const smooth = following.current && !prefersReducedMotion();

  useEffect(() => {
    if (!smooth) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const { text: current, streaming: live } = latest.current;
      if (!live && !current) {
        following.current = false;
        setShown('');
        return;
      }
      // The pace is measured from the first text, not from the thinking before it.
      if (!reveal.current && !current) {
        last = now;
        frame = requestAnimationFrame(tick);
        return;
      }
      reveal.current ??= initialReveal(now, current.length);
      // A replaced reply (a retried or restarted stream) is revealed from its start.
      if (!current.startsWith(shownRef.current))
        reveal.current = { ...reveal.current, position: 0 };
      reveal.current = advanceReveal(
        reveal.current,
        current.length,
        live,
        now,
        (now - last) / 1000,
      );
      last = now;
      shownRef.current = revealedText(current, reveal.current.position);
      setShown(shownRef.current);
      if (!live && reveal.current.position >= current.length) {
        reveal.current = null;
        following.current = false;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [smooth]);

  if (!smooth) return { text, revealing: false };
  return { text: shown, revealing: true };
}
