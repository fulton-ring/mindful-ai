import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Persona } from '@walden/contracts';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { readStoredPersona, writeStoredPersona } from './workspace-helpers';

export function usePersonaData(identity?: string) {
  const queryClient = useQueryClient();
  const personasQuery = useQuery({ queryKey: ['personas'], queryFn: api.personas, retry: false });
  const [personaId, setPersonaId] = useState(() => readStoredPersona(identity));
  useEffect(() => {
    writeStoredPersona(identity, personaId);
  }, [identity, personaId]);
  const [personaEditing, setPersonaEditing] = useState<Persona | null>(null);
  const personas = personasQuery.data ?? DEFAULT_PERSONAS;

  async function savePersona(value: Persona) {
    const replacesBuiltIn = Boolean(value.id && DEFAULT_PERSONAS.some((p) => p.id === value.id));
    const saved =
      !value.id || replacesBuiltIn
        ? await api.createPersona({
            name: value.name,
            icon: value.icon,
            prompt: value.prompt,
            brevity: value.brevity,
            challenge: value.challenge,
            tone: value.tone,
            ...(replacesBuiltIn ? { replacesPersonaId: value.id } : {}),
          })
        : await api.updatePersona(value);
    if (replacesBuiltIn) await api.deletePersona(value.id);
    queryClient.setQueryData<Persona[]>(['personas'], (all = []) => [
      ...all.filter((p) => p.id !== saved.id && (!replacesBuiltIn || p.id !== value.id)),
      saved,
    ]);
    setPersonaId(saved.id);
    setPersonaEditing(null);
  }

  async function deleteEditingPersona() {
    if (!personaEditing?.id) return;
    await api.deletePersona(personaEditing.id);
    queryClient.setQueryData<Persona[]>(['personas'], (all = []) =>
      all.filter((item) => item.id !== personaEditing.id),
    );
    if (personaId === personaEditing.id) setPersonaId('');
    setPersonaEditing(null);
  }

  async function deletePersona(persona: Persona) {
    await api.deletePersona(persona.id);
    queryClient.setQueryData<Persona[]>(['personas'], (all = []) =>
      all.filter((item) => item.id !== persona.id),
    );
    if (personaId === persona.id) setPersonaId('');
  }

  return {
    personaId,
    setPersonaId,
    personaEditing,
    setPersonaEditing,
    personas,
    savePersona,
    deleteEditingPersona,
    deletePersona,
  };
}
