// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonaEditor } from './PersonaEditor';
import { PersonaPicker } from './PersonaPicker';

afterEach(cleanup);
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
