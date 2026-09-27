import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { ChunkPreview, ModelProgress } from './checkpoints';
import { GemmaToolLeakDecoder } from './learning-checks';

type Decoders = Map<string, GemmaToolLeakDecoder>;

function decoderFor(decoders: Decoders, id: string) {
  let decoder = decoders.get(id);
  if (!decoder) {
    decoder = new GemmaToolLeakDecoder();
    decoders.set(id, decoder);
  }
  return decoder;
}

function textChunks(
  id: string,
  part: LanguageModelV3StreamPart,
  decoders: Decoders,
): WaldenUIMessageChunk[] {
  if (part.type === 'text-start') {
    decoders.set(id, new GemmaToolLeakDecoder());
    return [{ type: 'text-start', id }];
  }
  if (part.type === 'text-delta') {
    const delta = decoderFor(decoders, id).push(part.delta).text;
    return delta ? [{ type: 'text-delta', id, delta }] : [];
  }
  if (part.type !== 'text-end') return [];
  const rest = decoderFor(decoders, id).finish();
  decoders.delete(id);
  return [
    ...(rest ? [{ type: 'text-delta' as const, id, delta: rest }] : []),
    { type: 'text-end', id },
  ];
}

function reasoningChunks(id: string, part: LanguageModelV3StreamPart): WaldenUIMessageChunk[] {
  if (part.type === 'reasoning-start') return [{ type: 'reasoning-start', id }];
  if (part.type === 'reasoning-delta')
    return part.delta ? [{ type: 'reasoning-delta', id, delta: part.delta }] : [];
  if (part.type === 'reasoning-end') return [{ type: 'reasoning-end', id }];
  return [];
}

/**
 * Streams each model call's text and reasoning as UI chunks while the call runs
 * inside its checkpoint. Part ids are prefixed with the call name, so they are
 * unique across the reply and stable when a checkpointed call is replayed.
 */
export function modelPreview(preview: ChunkPreview): ModelProgress {
  const marks = new Map<string, number>();
  const decoders: Decoders = new Map();
  return {
    async begin(call) {
      const mark = marks.get(call);
      // A retried call replaces its failed attempt's partial output.
      if (mark !== undefined) await preview.rewind(mark);
      marks.set(call, preview.mark());
      await preview.write([{ type: 'start-step' }]);
    },
    parts: (call, parts) =>
      preview.write(
        parts.flatMap((part) => {
          if (!('id' in part)) return [];
          const id = `${call}:${part.id}`;
          return [...textChunks(id, part, decoders), ...reasoningChunks(id, part)];
        }),
      ),
    end: () => preview.write([{ type: 'finish-step' }]),
  };
}
