import { expect, it } from 'vitest';
import { aiProviderErrorMessage } from './ai-errors';

it('turns a provider gateway timeout into a retryable message', () => {
  const error = Object.assign(new Error('upstream unavailable'), { statusCode: 504 });
  expect(aiProviderErrorMessage(error)).toBe('The AI provider did not respond. Please try again.');
});
