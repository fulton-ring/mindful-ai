// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_PERSONAS, type Persona } from '@walden/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectivePersona, PersonaPicker } from '../PersonaPicker';

afterEach(cleanup);

describe('PersonaPicker', () => {
  it('shows Mentor as the effective default instead of an add control', () => {
    const view = render(<PersonaPicker personas={DEFAULT_PERSONAS} value="" onChange={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Change persona' }).textContent).toContain(
      'Mentor',
    );
    expect(view.container.querySelector('[data-persona-icon="thinking-partner"]')).toBeTruthy();
  });

  it('falls back when a saved persona has been deleted', () => {
    const view = render(
      <PersonaPicker personas={DEFAULT_PERSONAS} value="deleted-persona" onChange={vi.fn()} />,
    );
    expect(screen.getByRole('combobox', { name: 'Change persona' }).textContent).toContain(
      'Mentor',
    );
    view.rerender(
      <PersonaPicker
        personas={[DEFAULT_PERSONAS[1]!]}
        value="deleted-persona"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Change persona' }).textContent).toContain(
      'Challenger',
    );
  });

  it('keeps a selected custom persona through a parent rerender', () => {
    const custom: Persona = {
      ...DEFAULT_PERSONAS[0]!,
      id: 'custom-coach',
      name: 'Writing coach',
    };
    const personas = [...DEFAULT_PERSONAS, custom];
    const view = render(<PersonaPicker personas={personas} value={custom.id} onChange={vi.fn()} />);
    view.rerender(<PersonaPicker personas={personas} value={custom.id} onChange={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Change persona' }).textContent).toContain(
      'Writing coach',
    );
    expect(view.container.querySelector('[data-persona-icon="custom-coach"]')).toBeTruthy();
    expect(effectivePersona(personas, custom.id)).toBe(custom);
  });
});
