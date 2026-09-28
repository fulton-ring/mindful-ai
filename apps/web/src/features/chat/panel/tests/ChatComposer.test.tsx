// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { ChatComposer } from '../ui/ChatComposer';

it('offers PDF and Office documents in the file picker', () => {
  const view = render(
    <ChatComposer
      input=""
      sending={false}
      savingChatPreference={false}
      webSearch
      learningChecks
      autoHighlights
      personas={[]}
      personaId="thinking-partner"
      messageInput={{ current: null }}
      onInput={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onPersona={vi.fn()}
      onPreference={vi.fn()}
      onAutoHighlights={vi.fn()}
    />,
  );
  expect(view.container.querySelector('input[type="file"]')?.getAttribute('accept')).toContain(
    '.pdf',
  );
  expect(view.container.querySelector('input[type="file"]')?.getAttribute('accept')).toContain(
    '.docx',
  );
  expect(view.container.querySelector('input[type="file"]')?.getAttribute('accept')).toContain(
    '.xlsx',
  );
  view.unmount();
});

vi.mock('../../personas/PersonaPicker', () => ({
  PersonaPicker: () => null,
  effectivePersona: () => undefined,
}));

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

it('turns a large paste into a Markdown attachment without adding it to the draft', () => {
  const onAttach = vi.fn();
  const onInput = vi.fn();
  const view = render(
    <ChatComposer
      input=""
      sending={false}
      savingChatPreference={false}
      webSearch
      learningChecks
      autoHighlights
      personas={[]}
      personaId="thinking-partner"
      messageInput={{ current: null }}
      attachments={[]}
      onAttach={onAttach}
      onRemoveAttachment={vi.fn()}
      onInput={onInput}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onPersona={vi.fn()}
      onPreference={vi.fn()}
      onAutoHighlights={vi.fn()}
    />,
  );
  const input = within(view.container).getByLabelText('Message');
  fireEvent.paste(input, { clipboardData: { getData: () => 'a'.repeat(2001), files: [] } });
  expect(onAttach).toHaveBeenCalledWith([
    expect.objectContaining({ name: 'Pasted text.md', size: 2001 }),
  ]);
  expect(onInput).not.toHaveBeenCalledWith('a'.repeat(2001));
});

it('adds dropped files through the attachment flow', () => {
  const onAttach = vi.fn();
  const view = render(
    <ChatComposer
      input=""
      sending={false}
      savingChatPreference={false}
      webSearch
      learningChecks
      autoHighlights
      personas={[]}
      personaId="thinking-partner"
      messageInput={{ current: null }}
      attachments={[]}
      onAttach={onAttach}
      onInput={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onPersona={vi.fn()}
      onPreference={vi.fn()}
      onAutoHighlights={vi.fn()}
    />,
  );
  const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
  const input = within(view.container).getByLabelText('Message');
  const event = fireEvent.drop(input, { dataTransfer: { files: [file], types: ['Files'] } });
  expect(event).toBe(false);
  expect(onAttach).toHaveBeenCalledWith([file]);
});

it('rejects an unsupported dropped file before attaching it', () => {
  const onAttach = vi.fn();
  const view = render(
    <ChatComposer
      input=""
      sending={false}
      savingChatPreference={false}
      webSearch
      learningChecks
      autoHighlights
      personas={[]}
      personaId="thinking-partner"
      messageInput={{ current: null }}
      onAttach={onAttach}
      onInput={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onPersona={vi.fn()}
      onPreference={vi.fn()}
      onAutoHighlights={vi.fn()}
    />,
  );
  const form = view.container.querySelector('form');
  if (!form) throw new Error('Composer form missing');
  fireEvent.drop(form, {
    dataTransfer: {
      files: [new File(['no'], 'program.exe', { type: 'application/octet-stream' })],
      types: ['Files'],
    },
  });
  expect(onAttach).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toMatch(/supported/i);
});

it('uses the editor placeholder instead of overlaying text on the cursor', () => {
  const view = render(
    <ChatComposer
      input=""
      sending={false}
      savingChatPreference={false}
      webSearch
      learningChecks
      autoHighlights
      personas={[]}
      personaId="thinking-partner"
      messageInput={{ current: null }}
      onInput={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onPersona={vi.fn()}
      onPreference={vi.fn()}
      onAutoHighlights={vi.fn()}
    />,
  );
  expect(view.container.querySelector('.composer-placeholder')).toBeNull();
  expect(view.container.querySelector('.cm-placeholder')?.textContent).toBe('Message…');
});

it('does not submit the draft when stopping changes the button back to Send', () => {
  const onSend = vi.fn();
  function Harness() {
    const [sending, setSending] = React.useState(true);
    return (
      <ChatComposer
        input="Draft"
        sending={sending}
        savingChatPreference={false}
        webSearch
        learningChecks
        autoHighlights
        personas={[]}
        personaId="thinking-partner"
        messageInput={{ current: null }}
        onInput={vi.fn()}
        onSend={onSend}
        onStop={() => setSending(false)}
        onPersona={vi.fn()}
        onPreference={vi.fn()}
        onAutoHighlights={vi.fn()}
      />
    );
  }
  const view = render(<Harness />);
  fireEvent.click(within(view.container).getByRole('button', { name: 'Stop response' }));
  const send = within(view.container).getByRole('button', { name: 'Send message' });
  expect(send.getAttribute('type')).toBe('button');
  expect(onSend).not.toHaveBeenCalled();
});

it('explains a used-up message budget and disables the input once no reply is running', () => {
  const onSend = vi.fn();
  const budget = {
    used: 20,
    limit: 20,
    windowHours: 4,
    resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  const composer = (sending: boolean) => (
    <ChatComposer
      input="one more"
      sending={sending}
      savingChatPreference={false}
      webSearch
      learningChecks
      autoHighlights
      personas={[]}
      personaId="thinking-partner"
      budget={budget}
      messageInput={{ current: null }}
      onInput={vi.fn()}
      onSend={onSend}
      onStop={vi.fn()}
      onPersona={vi.fn()}
      onPreference={vi.fn()}
      onAutoHighlights={vi.fn()}
    />
  );
  const view = render(composer(true));
  const scope = within(view.container);
  // The reply that used the last of the budget is still coming in.
  expect(scope.queryByRole('status')).toBeNull();
  view.rerender(composer(false));
  expect(scope.getByRole('status').textContent).toMatch(/reached your message limit/);
  expect(scope.getByLabelText('Message').getAttribute('contenteditable')).toBe('false');
  fireEvent.click(scope.getByRole('button', { name: 'Send message' }));
  expect(onSend).not.toHaveBeenCalled();
  view.unmount();
});
