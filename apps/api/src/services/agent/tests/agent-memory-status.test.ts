import { describe, expect, it } from 'vitest';

import { streamMemoryPreparation } from '../agent-memory-stream';

describe('memory preparation status', () => {
  it('streams native compaction start before preparation completes', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stream = streamMemoryPreparation(async (emit) => {
      emit({ phase: 'observation', state: 'start' });
      await gate;
      emit({ phase: 'observation', state: 'end', observed: true });
      return 42;
    });

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'status', text: 'Compacting conversation context…' },
    });
    finish();
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'status', text: 'Context compacted. Thinking…' },
    });
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'context-compacted' },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: 42 });
  });

  it('emits nothing when native observation does not start', async () => {
    const stream = streamMemoryPreparation(async () => 42);
    await expect(stream.next()).resolves.toEqual({ done: true, value: 42 });
  });

  it('does not emit success when native observation fails', async () => {
    const stream = streamMemoryPreparation(async (emit) => {
      emit({ phase: 'observation', state: 'start' });
      emit({ phase: 'observation', state: 'end', error: new Error('private provider error') });
      throw new Error('private provider error');
    });

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'status', text: 'Compacting conversation context…' },
    });
    await expect(stream.next()).rejects.toThrow('private provider error');
  });

  it('does not emit success when native observation is skipped', async () => {
    const stream = streamMemoryPreparation(async (emit) => {
      emit({ phase: 'observation', state: 'start' });
      emit({ phase: 'observation', state: 'end', observed: false });
      return 42;
    });

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'status', text: 'Compacting conversation context…' },
    });
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'status', text: 'Thinking…' },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: 42 });
  });
});
