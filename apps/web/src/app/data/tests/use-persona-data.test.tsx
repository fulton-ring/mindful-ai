// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DEFAULT_PERSONAS, type Persona } from '@walden/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../lib/api';
import { usePersonaData } from '../use-persona-data';

const QWEN = '@cf/qwen/qwen3.8-27b';

function renderPersonas() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePersonaData('user'), { wrapper });
}

describe('saving personas', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'personas').mockResolvedValue(DEFAULT_PERSONAS);
    vi.spyOn(api, 'deletePersona').mockResolvedValue(undefined);
  });

  it('saves an edited built-in with its model and keeps it in the built-in slot', async () => {
    const mentor = DEFAULT_PERSONAS.find(({ name }) => name === 'Mentor')!;
    const create = vi
      .spyOn(api, 'createPersona')
      .mockImplementation(async ({ replacesPersonaId: _replaces, ...fields }) => ({
        ...fields,
        id: 'mentor-override',
      }));
    const { result } = renderPersonas();
    await waitFor(() => expect(result.current.personas).toEqual(DEFAULT_PERSONAS));

    await act(() => result.current.savePersona({ ...mentor, model: QWEN }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: QWEN, replacesPersonaId: mentor.id, name: 'Mentor' }),
    );
    const index = DEFAULT_PERSONAS.indexOf(mentor);
    expect(result.current.personas[index]).toMatchObject({ id: 'mentor-override', model: QWEN });
    expect(result.current.personas).toHaveLength(DEFAULT_PERSONAS.length);
  });

  it('saves a new persona with its model at the end of the list', async () => {
    vi.spyOn(api, 'createPersona').mockImplementation(async (fields) => ({
      ...(fields as Omit<Persona, 'id'>),
      id: 'custom',
    }));
    const { result } = renderPersonas();
    await waitFor(() => expect(result.current.personas).toEqual(DEFAULT_PERSONAS));

    await act(() =>
      result.current.savePersona({ ...DEFAULT_PERSONAS[0]!, id: '', name: 'Tutor', model: QWEN }),
    );

    expect(api.createPersona).toHaveBeenCalledWith(expect.objectContaining({ model: QWEN }));
    expect(result.current.personas.at(-1)).toMatchObject({ id: 'custom', model: QWEN });
  });
});
