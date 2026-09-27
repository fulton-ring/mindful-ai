import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { MemoryLifecycleEvent } from '../../agent/memory/memory';
import { metadataPatch, transientStatus } from '../../chat/messages';

export async function* streamMemoryPreparation<T>(
  prepare: (emit: (event: MemoryLifecycleEvent) => void) => Promise<T>,
): AsyncGenerator<WaldenUIMessageChunk, T> {
  const queue: WaldenUIMessageChunk[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let result: T | undefined;
  let failure: unknown;
  const emit = (event: MemoryLifecycleEvent) => {
    if (event.phase !== 'observation') return;
    if (event.state === 'start') {
      queue.push(transientStatus('Compacting conversation context…'));
    } else if (!event.error) {
      if (event.observed) {
        queue.push(transientStatus('Context compacted. Thinking…'));
        queue.push({
          type: 'message-metadata',
          messageMetadata: metadataPatch({ contextCompacted: true }),
        });
      } else {
        queue.push(transientStatus('Thinking…'));
      }
    }
    wake?.();
    wake = undefined;
  };
  void prepare(emit).then(
    (value) => {
      result = value;
      settled = true;
      wake?.();
    },
    (error) => {
      failure = error;
      settled = true;
      wake?.();
    },
  );
  while (!settled || queue.length) {
    while (queue.length) yield queue.shift()!;
    if (!settled) await new Promise<void>((resolve) => (wake = resolve));
  }
  if (failure) throw failure;
  return result as T;
}
