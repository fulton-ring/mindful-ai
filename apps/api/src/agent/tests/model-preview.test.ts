import type { WaldenUIMessageChunk } from '@walden/contracts';
import { expect, it, vi } from 'vitest';
import type { ChunkPreview } from '../checkpoints';
import { modelPreview } from '../model-preview';

function recordingPreview() {
  const written: WaldenUIMessageChunk[] = [];
  const preview: ChunkPreview = {
    mark: () => written.length,
    write: async (chunks) => {
      written.push(...chunks);
    },
    rewind: vi.fn(async (mark: number) => {
      written.length = mark;
    }),
  };
  return { written, preview };
}

it('brackets each call with steps and prefixes part ids with the call name', async () => {
  const { written, preview } = recordingPreview();
  const progress = modelPreview(preview);
  await progress.begin('chat-stream-1');
  await progress.parts('chat-stream-1', [
    { type: 'reasoning-start', id: 'r' },
    { type: 'reasoning-delta', id: 'r', delta: 'Think.' },
    { type: 'reasoning-end', id: 'r' },
    { type: 'text-start', id: 'a' },
    { type: 'text-delta', id: 'a', delta: 'Hello' },
  ]);
  await progress.parts('chat-stream-1', [
    { type: 'text-delta', id: 'a', delta: ' there' },
    { type: 'text-end', id: 'a' },
  ]);
  await progress.end('chat-stream-1');
  await progress.begin('chat-stream-2');
  await progress.parts('chat-stream-2', [
    { type: 'text-start', id: 'a' },
    { type: 'text-delta', id: 'a', delta: 'Again' },
    { type: 'text-end', id: 'a' },
  ]);
  await progress.end('chat-stream-2');
  expect(written).toEqual([
    { type: 'start-step' },
    { type: 'reasoning-start', id: 'chat-stream-1:r' },
    { type: 'reasoning-delta', id: 'chat-stream-1:r', delta: 'Think.' },
    { type: 'reasoning-end', id: 'chat-stream-1:r' },
    { type: 'text-start', id: 'chat-stream-1:a' },
    { type: 'text-delta', id: 'chat-stream-1:a', delta: 'Hello' },
    { type: 'text-delta', id: 'chat-stream-1:a', delta: ' there' },
    { type: 'text-end', id: 'chat-stream-1:a' },
    { type: 'finish-step' },
    { type: 'start-step' },
    { type: 'text-start', id: 'chat-stream-2:a' },
    { type: 'text-delta', id: 'chat-stream-2:a', delta: 'Again' },
    { type: 'text-end', id: 'chat-stream-2:a' },
    { type: 'finish-step' },
  ]);
  expect(preview.rewind).not.toHaveBeenCalled();
});

it('withholds leaked Gemma tool markup from preview text', async () => {
  const { written, preview } = recordingPreview();
  const progress = modelPreview(preview);
  await progress.begin('chat-stream-1');
  await progress.parts('chat-stream-1', [
    { type: 'text-start', id: 'a' },
    { type: 'text-delta', id: 'a', delta: 'Quiz time. propose' },
    { type: 'text-delta', id: 'a', delta: 'Ask{question:<|"|>Which?<|"|>,options:[<|"|>A<|"|>,' },
    { type: 'text-delta', id: 'a', delta: '<|"|>B<|"|>]} Done.' },
    { type: 'text-end', id: 'a' },
  ]);
  const text = written.map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : '')).join('');
  expect(text).toBe('Quiz time.  Done.');
  expect(text).not.toContain('proposeAsk');
});

it('rewinds a retried call to the mark taken when it first began', async () => {
  const { written, preview } = recordingPreview();
  const progress = modelPreview(preview);
  await preview.write([{ type: 'start', messageId: 'turn' }]);
  await progress.begin('chat-stream-1');
  await progress.parts('chat-stream-1', [
    { type: 'text-start', id: 'a' },
    { type: 'text-delta', id: 'a', delta: 'Partial' },
  ]);
  await progress.begin('chat-stream-1');
  expect(preview.rewind).toHaveBeenCalledWith(1);
  await progress.parts('chat-stream-1', [
    { type: 'text-start', id: 'a' },
    { type: 'text-delta', id: 'a', delta: 'Whole' },
    { type: 'text-end', id: 'a' },
  ]);
  await progress.end('chat-stream-1');
  expect(written).toEqual([
    { type: 'start', messageId: 'turn' },
    { type: 'start-step' },
    { type: 'text-start', id: 'chat-stream-1:a' },
    { type: 'text-delta', id: 'chat-stream-1:a', delta: 'Whole' },
    { type: 'text-end', id: 'chat-stream-1:a' },
    { type: 'finish-step' },
  ]);
});
