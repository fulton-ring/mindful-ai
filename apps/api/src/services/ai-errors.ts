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
