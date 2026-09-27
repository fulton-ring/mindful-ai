// @vitest-environment jsdom

import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useVisualViewport } from '../use-visual-viewport';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--visible-viewport-height');
  document.documentElement.style.removeProperty('--visible-viewport-top');
});

it('tracks the visible viewport when a mobile keyboard opens and closes', () => {
  const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
  viewport.height = 800;
  viewport.offsetTop = 0;
  vi.stubGlobal('visualViewport', viewport);
  function Harness() {
    useVisualViewport();
    return null;
  }
  const view = render(<Harness />);
  expect(document.documentElement.style.getPropertyValue('--visible-viewport-height')).toBe(
    '800px',
  );
  act(() => {
    viewport.height = 420;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(document.documentElement.style.getPropertyValue('--visible-viewport-height')).toBe(
    '420px',
  );
  expect(document.documentElement.style.getPropertyValue('--visible-viewport-top')).toBe('12px');
  view.unmount();
  expect(document.documentElement.style.getPropertyValue('--visible-viewport-height')).toBe('');
});
