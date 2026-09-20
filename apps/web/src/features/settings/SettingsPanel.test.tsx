// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

afterEach(cleanup);

function renderSettings(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SettingsPanel
        config={{ authConfigured: false, billingConfigured: false, modelConfigured: true }}
        theme="light"
        onTheme={vi.fn()}
        personas={[]}
        onEditPersona={vi.fn()}
        onCreatePersona={vi.fn()}
        onDeletePersona={vi.fn()}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { ...view, onClose };
}

describe('SettingsPanel modal', () => {
  it('uses local tabs without changing the page URL', () => {
    history.replaceState(null, '', '/conversations/thread-1');
    const view = renderSettings();

    expect(view.getByRole('dialog')).toBeTruthy();
    expect(view.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /appearance/i }));

    expect(view.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
    expect(location.pathname).toBe('/conversations/thread-1');
  });

  it('closes from the top-right control and Escape', () => {
    const first = renderSettings();
    fireEvent.click(first.getByRole('button', { name: 'Close settings' }));
    expect(first.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderSettings();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});
