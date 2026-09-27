import type { ChatFailureCode } from '@walden/contracts';

function providerStatus(error: Error): number | undefined {
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  const match = /Workers AI API error \((\d{3})\b/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

/** Stable diagnostic category; never contains a provider response or prompt. */
export function aiFailureCode(error: unknown): ChatFailureCode {
  if (error instanceof Error) {
    const status = providerStatus(error);
    if (/daily free allocation/i.test(error.message)) return 'quota_exhausted';
    if (status === 429 || /\b429\b/.test(error.message)) return 'rate_limited';
    if (status !== undefined && status >= 500) return 'provider_unavailable';
    if (/output limit/i.test(error.message)) return 'output_limit';
    if (error.message.includes('Workers AI API error')) return 'provider_error';
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
  }
  return 'internal_error';
}

/** Provider failures are operational; do not expose their raw response payloads. */
export function aiProviderErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return;
  if ('statusCode' in error && typeof error.statusCode === 'number') {
    if (error.statusCode === 429) return 'The AI service is busy. Please try again shortly.';
    if (error.statusCode >= 500) return 'The AI provider did not respond. Please try again.';
  }
  if (!error.message.includes('Workers AI API error')) return;
  if (/daily free allocation/i.test(error.message))
    return 'AI replies are unavailable because the provider’s daily allowance has been reached. Try again after it resets.';
  if (/\b429\b/.test(error.message)) return 'The AI service is busy. Please try again shortly.';
  return 'The AI service could not complete this response. Please try again.';
}
