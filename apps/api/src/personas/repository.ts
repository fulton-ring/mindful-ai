import { DEFAULT_PERSONAS, type Persona } from '@walden/contracts';
import { first } from '../db/client';
import type { AppDatabase } from '../db/database';

export type PersonaRow = {
  id: string;
  name: string;
  prompt: string;
  model: Persona['model'] | null;
  brevity: Persona['brevity'];
  challenge: Persona['challenge'];
  tone: Persona['tone'];
  icon: Persona['icon'] | null;
  replaces_persona_id: string | null;
};

export const PERSONA_COLUMNS =
  'id,name,prompt,model,brevity,challenge,tone,icon,replaces_persona_id';

/** A custom persona without its own icon keeps the icon of the built-in it replaces. */
export const toPersona = ({
  replaces_persona_id: replaces,
  icon,
  model,
  ...row
}: PersonaRow): Persona => ({
  ...row,
  ...(model ? { model } : {}),
  icon: icon ?? DEFAULT_PERSONAS.find((persona) => persona.id === replaces)?.icon ?? 'user',
});

export const loadPersonaRow = (db: AppDatabase, ownerId: string, id: string) =>
  first<PersonaRow>(
    db
      .prepare(`SELECT ${PERSONA_COLUMNS} FROM personas WHERE id=? AND owner_id=?`)
      .bind(id, ownerId),
  );

export const loadPersona = async (db: AppDatabase, ownerId: string, id: string) => {
  const row = await loadPersonaRow(db, ownerId, id);
  return row ? toPersona(row) : null;
};
