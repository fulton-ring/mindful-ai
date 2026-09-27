import type { Conversation } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { textMessage } from '../../../tests/ui-messages';
import { editContext, regenerationContext } from '../turn-support';

const messages = (incomplete: boolean): Conversation['messages'] => [
  textMessage('user-1', 'user', 'Explain tides.'),
  textMessage('assistant-1', 'assistant', 'Tides are', {
    status: incomplete ? 'interrupted' : 'complete',
  }),
];

describe('retrying a response that never completed', () => {
  it('refuses to regenerate an incomplete response', () => {
    // This is why the retry control resends the prior user message instead of
    // calling regenerate: the server has no completed response to replace.
    expect(regenerationContext(messages(true), 'assistant-1')).toBeNull();
  });

  it('regenerates once the response completed', () => {
    expect(regenerationContext(messages(false), 'assistant-1')).not.toBeNull();
  });

  it('accepts the prior user message as an edit target so the retry replaces the failed turn', () => {
    expect(editContext(messages(true), 'user-1')).not.toBeNull();
  });
});
