// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';

import { handleLiveChatEvent } from '../hooks/actions/live-chat-event';
import { useChatDisplayState } from '../hooks/state/use-chat-display-state';
import { useChatTurn } from '../hooks/state/use-chat-turn';

it('accumulates live response text, activity, context, and annotations', () => {
  const { result } = renderHook(() => {
    const display = useChatDisplayState();
    return { display, turn: useChatTurn(display.setStreamed) };
  });
  act(() => {
    handleLiveChatEvent(result.current, { type: 'text', text: 'Hello' });
    handleLiveChatEvent(result.current, { type: 'text', text: ' world' });
    handleLiveChatEvent(result.current, { type: 'status', text: 'Reading' });
    handleLiveChatEvent(result.current, { type: 'reasoning', text: 'First. ' });
    handleLiveChatEvent(result.current, { type: 'reasoning', text: 'Second.' });
    handleLiveChatEvent(result.current, {
      type: 'tool',
      tool: { id: 'tool-1', name: 'readWebPage', state: 'running', summary: 'Reading page' },
    });
    handleLiveChatEvent(result.current, {
      type: 'tool',
      tool: { id: 'tool-1', name: 'readWebPage', state: 'complete', summary: 'Page read' },
    });
    handleLiveChatEvent(result.current, {
      type: 'source',
      source: { id: 'source-1', url: 'https://example.com', title: 'Example' },
    });
    handleLiveChatEvent(result.current, { type: 'context-compacted' });
    handleLiveChatEvent(result.current, {
      type: 'annotation',
      annotation: { id: 'fact-1', kind: 'fact', whose: 'assistant', quote: 'Hello world' },
    });
    result.current.turn.flushStream();
  });
  expect(result.current.display.streamed).toBe('Hello world');
  expect(result.current.display.status).toBe('Reading');
  expect(result.current.display.reasoning).toBe('First. Second.');
  expect(result.current.display.liveTools).toEqual([
    expect.objectContaining({ id: 'tool-1', state: 'complete' }),
  ]);
  expect(result.current.display.liveSources).toEqual([expect.objectContaining({ id: 'source-1' })]);
  expect(result.current.display.liveContextCompacted).toBe(true);
  expect(result.current.display.liveAnnotations).toEqual([
    expect.objectContaining({ id: 'fact-1' }),
  ]);
});

it('replaces provisional text after a Workflow attempt resets', () => {
  const { result } = renderHook(() => {
    const display = useChatDisplayState();
    return { display, turn: useChatTurn(display.setStreamed) };
  });
  act(() => {
    handleLiveChatEvent(result.current, {
      type: 'text-snapshot',
      text: 'First attempt',
      reasoning: '',
    });
    result.current.turn.flushStream();
    handleLiveChatEvent(result.current, { type: 'reset' });
    handleLiveChatEvent(result.current, { type: 'text-snapshot', text: 'Second', reasoning: '' });
    result.current.turn.flushStream();
  });
  expect(result.current.display.streamed).toBe('Second');
});
