import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

function abortError(signal: AbortSignal): DOMException {
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'The operation was aborted.',
    'AbortError',
  );
}

function withRequestSignal(
  options: LanguageModelV3CallOptions,
  requestSignal: AbortSignal,
): LanguageModelV3CallOptions {
  if (requestSignal.aborted) throw abortError(requestSignal);
  if (options.abortSignal?.aborted) throw abortError(options.abortSignal);
  return {
    ...options,
    abortSignal: options.abortSignal
      ? AbortSignal.any([requestSignal, options.abortSignal])
      : requestSignal,
  };
}

export function abortableObservationModel(
  model: LanguageModelV3,
  requestSignal: AbortSignal,
): LanguageModelV3 {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (options) => model.doGenerate(withRequestSignal(options, requestSignal)),
    doStream: async (options) => model.doStream(withRequestSignal(options, requestSignal)),
  };
}
