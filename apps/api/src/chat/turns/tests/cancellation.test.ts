import { describe, expect, it, vi } from 'vitest';
import { createDurableStream } from '../routes';

describe('durable chat stream cancellation', () => {
  it('runs cancellation immediately while cleanup continues in waitUntil', async () => {
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const abort = vi.fn();
    const waitUntil = vi.fn();
    const stream = createDurableStream(() => cleanup, abort, waitUntil);

    const reader = stream.getReader();
    const cancellation = reader.cancel();

    expect(abort).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(cleanup);
    finish();
    await cancellation;
  });
});
