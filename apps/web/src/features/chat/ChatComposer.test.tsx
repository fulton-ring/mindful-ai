// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './ChatComposer';

vi.mock('../personas/PersonaPicker', () => ({
  PersonaPicker: () => null,
  effectivePersona: () => undefined,
}));

describe('ChatComposer', () => {
  it('sends on Enter and keeps Shift+Enter available for a newline', () => {
    const onSend = vi.fn();
    render(
      <ChatComposer
        input="hello"
        sending={false}
        savingChatPreference={false}
        webSearch
        learningChecks
        autoHighlights
        personas={[]}
        personaId="thinking-partner"
        messageInput={{ current: null }}
        onInput={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
        onPersona={vi.fn()}
        onPreference={vi.fn()}
        onAutoHighlights={vi.fn()}
      />,
    );

    const input = screen.getByLabelText('Message');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledOnce();
  });
});
