import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';

import { abortableObservationModel } from '../observation-model';

const options = (abortSignal?: AbortSignal) =>
  ({ prompt: [], abortSignal }) as LanguageModelV3CallOptions;

function provider() {
  return {
    specificationVersion: 'v3',
    provider: 'workers-ai',
    modelId: 'test-model',
    supportedUrls: { 'image/*': [/^https:\/\/example\.com\//] },
    doGenerate: vi.fn(async () => ({ generated: true })),
    doStream: vi.fn(async () => ({ streamed: true })),
  } as unknown as LanguageModelV3;
}

describe('abortableObservationModel', () => {
  it('preserves model identity and delegates both provider methods', async () => {
    const model = provider();
    const wrapped = abortableObservationModel(model, new AbortController().signal);

    expect(wrapped).toMatchObject({
      specificationVersion: 'v3',
      provider: model.provider,
      modelId: model.modelId,
      supportedUrls: model.supportedUrls,
    });
    await wrapped.doGenerate(options());
    await wrapped.doStream(options());

    expect(model.doGenerate).toHaveBeenCalledOnce();
    expect(model.doStream).toHaveBeenCalledOnce();
  });

  it.each(['doGenerate', 'doStream'] as const)(
    'combines the request signal with the original signal for %s',
    async (method) => {
      const model = provider();
      const request = new AbortController();
      const original = new AbortController();
      const wrapped = abortableObservationModel(model, request.signal);

      await wrapped[method](options(original.signal));
      const forwarded = vi.mocked(model[method]).mock.calls[0][0];

      expect(forwarded.abortSignal).not.toBe(request.signal);
      expect(forwarded.abortSignal).not.toBe(original.signal);
      expect(forwarded.abortSignal?.aborted).toBe(false);
      original.abort('provider cancelled');
      expect(forwarded.abortSignal?.aborted).toBe(true);
      expect(forwarded.abortSignal?.reason).toBe('provider cancelled');
    },
  );

  it('binds an in-flight provider call to request cancellation', async () => {
    const model = provider();
    const request = new AbortController();
    const original = new AbortController();
    const wrapped = abortableObservationModel(model, request.signal);

    await wrapped.doGenerate(options(original.signal));
    const forwarded = vi.mocked(model.doGenerate).mock.calls[0][0];
    request.abort('request cancelled');

    expect(forwarded.abortSignal?.aborted).toBe(true);
    expect(forwarded.abortSignal?.reason).toBe('request cancelled');
  });

  it.each(['doGenerate', 'doStream'] as const)(
    'does not call %s when the request is already aborted',
    async (method) => {
      const model = provider();
      const request = new AbortController();
      request.abort('request cancelled');
      const wrapped = abortableObservationModel(model, request.signal);

      await expect(wrapped[method](options())).rejects.toMatchObject({ name: 'AbortError' });
      expect(model[method]).not.toHaveBeenCalled();
    },
  );
});
