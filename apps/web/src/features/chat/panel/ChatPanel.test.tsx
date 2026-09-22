// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatEvent } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '../ChatPanel';
import { conversation, getTransport, props } from './_ChatPanel.test-helpers';

const transport = getTransport();

describe('streamed response activity', () => {
  it('updates tools in place, exposes sources, and clears activity when switching threads', async () => {
    let emit: (event: ChatEvent) => void = () => undefined;
    transport.streamChat.mockImplementation((_input, onEvent) => {
      emit = onEvent;
      return new Promise(() => undefined);
    });
    const values = props();
    const view = render(<ChatPanel {...values} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Read a page' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(transport.streamChat).toHaveBeenCalledTimes(1));
    act(() => emit({ type: 'context-compacted' }));
    expect(screen.getByLabelText('Context compacted')).toBeTruthy();
    act(() =>
      emit({
        type: 'tool',
        tool: { id: 'call-1', name: 'readWebPage', state: 'running', summary: 'Reading page' },
      }),
    );
    // Open already, with no click: while the turn is running this panel is the
    // only progress the reader gets, and a collapsed one made a multi-second
    // tool call look like the app had stalled and then answered all at once.
    expect(screen.getByText('Read page')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.queryByText('Read page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    act(() => {
      emit({
        type: 'tool',
        tool: { id: 'call-1', name: 'readWebPage', state: 'complete', summary: 'Read example.com' },
      });
      emit({
        type: 'source',
        source: { id: 'source-1', url: 'https://example.com/', title: 'Example Domain' },
      });
    });
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Example Domain' }).getAttribute('href')).toBe(
      'https://example.com/',
    );
    const assistant = document.querySelector('article.message.assistant');
    expect(assistant).toBeTruthy();
    const activity = assistant?.querySelector('[aria-label="Response activity"]');
    const responseText = assistant?.querySelector(
      'article.message.assistant > div:not([aria-label])',
    );
    const sources = assistant?.querySelector('[aria-label="Response sources"]');
    expect(activity?.compareDocumentPosition(responseText as Node) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(responseText?.compareDocumentPosition(sources as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByRole('button', { name: '1 source' })).toBeTruthy();
    expect(activity?.contains(screen.getByRole('link', { name: 'Example Domain' }))).toBe(true);
    view.rerender(<ChatPanel {...props(conversation('conversation-2'))} />);
    expect(screen.queryByLabelText('Context compacted')).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Example Domain' })).toBeNull();
  });
});

describe('prompt tools', () => {
  it('lets people turn automatic highlights off', () => {
    render(<ChatPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
    const highlights = screen.getByRole('checkbox', { name: 'Auto highlights' });
    expect((highlights as HTMLInputElement).checked).toBe(true);
    fireEvent.click(highlights);
    expect((highlights as HTMLInputElement).checked).toBe(false);
    // There is no note toggle: suggestions are only ever asked for, so there is
    // nothing automatic to switch off.
    expect(screen.queryByRole('checkbox', { name: 'Auto note suggestions' })).toBeNull();
  });
});

it('can enable and disable learning checks before any quiz without sending a message', async () => {
  const value = conversation('quiz-toggle');
  const callbacks = props(value);
  transport.setLearningChecks.mockImplementation(async (_id, enabled) => ({
    learningChecksEnabled: enabled,
  }));
  const view = render(<ChatPanel {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
  const toggle = screen.getByRole('checkbox', { name: 'Learning checks' });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  await act(async () => {
    fireEvent.click(toggle);
  });
  await waitFor(() =>
    expect(callbacks.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({ learningChecksEnabled: true }),
    ),
  );
  view.rerender(
    <ChatPanel {...callbacks} conversation={{ ...value, learningChecksEnabled: true }} />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Learning checks' }));
  });
  await waitFor(() =>
    expect(transport.setLearningChecks).toHaveBeenLastCalledWith(value.id, false),
  );
  expect(transport.streamChat).not.toHaveBeenCalled();
  view.unmount();
});

it('toggles web search without sending a message', async () => {
  const value = conversation('search-toggle');
  const callbacks = props(value);
  transport.setWebSearch.mockImplementation(async (_id, enabled) => ({
    webSearchEnabled: enabled,
  }));
  const view = render(<ChatPanel {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chat tools' }));
  expect((screen.getByRole('checkbox', { name: 'Web search' }) as HTMLInputElement).checked).toBe(
    true,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Web search' }));
  });
  await waitFor(() =>
    expect(callbacks.onConversation).toHaveBeenCalledWith(
      expect.objectContaining({ webSearchEnabled: false }),
    ),
  );
  view.rerender(<ChatPanel {...callbacks} conversation={{ ...value, webSearchEnabled: false }} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Web search' }));
  });
  await waitFor(() => expect(transport.setWebSearch).toHaveBeenLastCalledWith(value.id, true));
  expect(transport.streamChat).not.toHaveBeenCalled();
  view.unmount();
});
