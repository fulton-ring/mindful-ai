// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setRuntimeConfig } from '../../../../lib/runtime-config';
import { ChatToolsMenu } from '../ui/ChatToolsMenu';

// These tests exercise capability/preference state, not the popover's positioning and focus engine.
vi.mock('../../../../components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  setRuntimeConfig(undefined);
});

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

    const webSearch = screen.getByLabelText('Web search');
    const autoHighlights = screen.getByLabelText('Auto highlights');
    expect((webSearch as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Learning checks') as HTMLInputElement).disabled).toBe(true);
    expect((autoHighlights as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(autoHighlights);
    expect(onPreference).not.toHaveBeenCalled();
    expect(onAutoHighlights).toHaveBeenCalledWith(false);
  });
});
it('explains missing search and document capabilities without advertising them as ready', () => {
  setRuntimeConfig({
    authConfigured: false,
    modelConfigured: false,
    capabilities: {
      documentExtraction: false,
      documentTypes: [],
      renderedPageRead: false,
      pageLinks: false,
      pageScreenshot: false,
      savedSourceSearch: false,
      webSearch: false,
    },
  });
  render(
    <ChatToolsMenu
      webSearch
      learningChecks={false}
      autoHighlights
      disabled={false}
      onPreference={vi.fn()}
      onAutoHighlights={vi.fn()}
    />,
  );
  expect((screen.getByLabelText('Web search') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Document attachments are unavailable/)).toBeTruthy();
});
