// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonaEditor } from '../PersonaEditor';
import { PersonaPicker } from '../PersonaPicker';

afterEach(cleanup);
it('offers GLM by default and keeps the model selector enabled', () => {
  const editor = render(
    <PersonaEditor persona={DEFAULT_PERSONAS[0]!} onSave={vi.fn()} onClose={vi.fn()} />,
  );
  const model = editor.getByRole('combobox', { name: 'Model' });
  expect(model.textContent).toContain('GLM 5.3 Flash');
  expect(model.hasAttribute('disabled')).toBe(false);
});

it('saves the chosen icon and renders it for a custom persona', async () => {
  const onSave = vi.fn();
  const persona = { ...DEFAULT_PERSONAS[0]!, id: 'custom-coach' };
  const editor = render(<PersonaEditor persona={persona} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.click(editor.getByRole('button', { name: 'Book icon' }));
  expect(editor.getByRole('button', { name: 'Book icon' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  fireEvent.click(editor.getByRole('button', { name: 'Save persona' }));
  expect(onSave).toHaveBeenCalledWith({ ...persona, icon: 'book' });
  editor.unmount();
  const picker = render(
    <PersonaPicker
      personas={[{ ...persona, icon: 'book' }]}
      value={persona.id}
      onChange={vi.fn()}
    />,
  );
  expect(picker.container.querySelector('[data-icon="book"]')).toBeTruthy();
});
it('shows the deployment catalog and requires reselecting an unavailable saved model', async () => {
  const { setRuntimeConfig } = await import('../../../lib/runtime-config');
  setRuntimeConfig({
    authConfigured: true,
    modelConfigured: true,
    inference: {
      configured: true,
      defaultModel: 'local',
      provider: 'openai-compatible',
      catalogSource: 'configured',
      catalogStale: false,
      models: [
        {
          id: 'local',
          name: 'Local model',
          weight: 3,
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsStructuredOutput: true,
        },
      ],
    },
  });
  try {
    const view = render(
      <PersonaEditor
        persona={{ ...DEFAULT_PERSONAS[0]!, model: 'retired/model' }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(view.getByText(/unavailable on this instance/)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Save persona' }).hasAttribute('disabled')).toBe(true);
    expect(view.getByRole('combobox', { name: 'Model' }).textContent).toContain('retired/model');
    expect(view.queryByText('GLM 5.3 Flash')).toBeNull();
  } finally {
    setRuntimeConfig(undefined);
  }
});
