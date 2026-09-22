// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatToolsMenu } from '../ui/ChatToolsMenu';

describe('ChatToolsMenu', () => {
  it('keeps saved preferences disabled while a turn is active', () => {
    const onPreference = vi.fn();
    const onAutoHighlights = vi.fn();
    render(
      <ChatToolsMenu
        webSearch
        learningChecks
        autoHighlights
        disabled
        onPreference={onPreference}
        onAutoHighlights={onAutoHighlights}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
    const webSearch = screen.getByRole('checkbox', { name: 'Web search' });
    const autoHighlights = screen.getByRole('checkbox', { name: 'Auto highlights' });
    expect((webSearch as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Learning checks' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect((autoHighlights as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(autoHighlights);
    expect(onPreference).not.toHaveBeenCalled();
    expect(onAutoHighlights).toHaveBeenCalledWith(false);
  });
});
