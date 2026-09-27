import { useRef } from 'react';

function truncateDisplayedStream(
  target: string,
  displayed: { current: string },
  frame: { current: number | undefined },
  setStreamed: (text: string) => void,
) {
  if (target.length >= displayed.current.length) return;
  if (frame.current !== undefined) cancelAnimationFrame(frame.current);
  frame.current = undefined;
  displayed.current = target;
  setStreamed(target);
}

/** Owns the animated response buffer and completion hand-off for a turn. */
export function useChatTurn(setStreamed: (text: string) => void) {
  const streamTarget = useRef('');
  const displayedStream = useRef('');
  const streamCompletionId = useRef<string | null>(null);
  const responseRenderKeys = useRef(new Map<string, string>());
  const streamFrame = useRef<number | undefined>(undefined);
  const lastStreamFrame = useRef<number | undefined>(undefined);
  const onStreamDrained = useRef<(() => void) | undefined>(undefined);

  function displayStreamTarget(target: string) {
    truncateDisplayedStream(target, displayedStream, streamFrame, setStreamed);
    streamTarget.current = target;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false) {
      displayedStream.current = target;
      setStreamed(target);
      onStreamDrained.current?.();
      onStreamDrained.current = undefined;
      return;
    }
    if (streamFrame.current !== undefined) return;
    const reveal = (timestamp: number) => {
      streamFrame.current = undefined;
      const pending = streamTarget.current.slice(displayedStream.current.length);
      if (!pending) {
        lastStreamFrame.current = undefined;
        onStreamDrained.current?.();
        onStreamDrained.current = undefined;
        return;
      }
      const elapsed = Math.min(100, timestamp - (lastStreamFrame.current ?? timestamp - 16));
      lastStreamFrame.current = timestamp;
      const count = Math.max(1, Math.ceil((elapsed * Math.max(90, pending.length * 6)) / 1000));
      const next = displayedStream.current + pending.slice(0, count);
      displayedStream.current = next;
      setStreamed(next);
      if (next.length < streamTarget.current.length)
        streamFrame.current = requestAnimationFrame(reveal);
      else {
        lastStreamFrame.current = undefined;
        onStreamDrained.current?.();
        onStreamDrained.current = undefined;
      }
    };
    streamFrame.current = requestAnimationFrame(reveal);
  }

  function flushStream() {
    if (streamFrame.current !== undefined) cancelAnimationFrame(streamFrame.current);
    streamFrame.current = undefined;
    lastStreamFrame.current = undefined;
    displayedStream.current = streamTarget.current;
    setStreamed(streamTarget.current);
    onStreamDrained.current?.();
    onStreamDrained.current = undefined;
  }

  return {
    streamTarget,
    displayedStream,
    streamCompletionId,
    responseRenderKeys,
    streamFrame,
    lastStreamFrame,
    onStreamDrained,
    displayStreamTarget,
    flushStream,
  };
}

export type ChatTurnState = ReturnType<typeof useChatTurn>;
