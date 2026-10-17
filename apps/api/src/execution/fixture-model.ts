/** Deterministic provider used by both Node and actual workerd execution checks. */
export function deterministicModel() {
  return {
    specificationVersion: 'v3' as const,
    provider: 'fixture',
    modelId: 'fixture',
    supportedUrls: {},
    async doGenerate(): Promise<never> {
      throw new Error('Streaming only');
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'answer' });
            controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Native answer.' });
            controller.enqueue({ type: 'text-end', id: 'answer' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
            });
            controller.close();
          },
        }),
      };
    },
  };
}
