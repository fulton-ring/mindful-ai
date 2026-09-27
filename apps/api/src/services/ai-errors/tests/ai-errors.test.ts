import { expect, it } from 'vitest';
import { aiFailureCode, aiProviderErrorMessage } from '../ai-errors';

it('turns a provider gateway timeout into a retryable message', () => {
  const error = Object.assign(new Error('upstream unavailable'), { statusCode: 504 });
  expect(aiProviderErrorMessage(error)).toBe('The AI provider did not respond. Please try again.');
});

it('classifies provider failures without including response bodies', () => {
  expect(aiFailureCode(Object.assign(new Error('secret payload'), { statusCode: 429 }))).toBe(
    'rate_limited',
  );
  expect(aiFailureCode(new Error('Workers AI API error: daily free allocation'))).toBe(
    'quota_exhausted',
  );
  expect(aiFailureCode(Object.assign(new Error('secret payload'), { statusCode: 503 }))).toBe(
    'provider_unavailable',
  );
  expect(aiFailureCode(new Error('private prompt'))).toBe('internal_error');
});
