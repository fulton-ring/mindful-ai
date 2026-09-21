import type { Message } from '@walden/contracts';
import { useEffect, useRef, useState } from 'react';

type CopyFailure = (message: string) => void;

/** Owns message-level actions whose state is independent of the turn stream. */
export function useMessageActions(onFailure: CopyFailure) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copiedMessageTimeout = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copiedMessageTimeout.current !== undefined)
        window.clearTimeout(copiedMessageTimeout.current);
    };
  }, []);

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      if (copiedMessageTimeout.current !== undefined)
        window.clearTimeout(copiedMessageTimeout.current);
      copiedMessageTimeout.current = window.setTimeout(
        () => setCopiedMessageId((current) => (current === message.id ? null : current)),
        1600,
      );
    } catch {
      onFailure('The response could not be copied.');
    }
  }

  return { copiedMessageId, copyMessage };
}
