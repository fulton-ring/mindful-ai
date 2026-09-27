import { type Conversation, DEFAULT_PERSONAS, type Persona } from '@walden/contracts';
import { HttpError } from '../../http';
import { loadPersona } from '../../personas/repository';
import { isInterrupted } from '../messages';

export function regenerationContext(messages: Conversation['messages'], assistantId: string) {
  const assistantIndex = messages.findIndex(({ id }) => id === assistantId);
  const assistant = messages[assistantIndex];
  const user = messages[assistantIndex - 1];
  if (
    !assistant ||
    assistant.id !== assistantId ||
    assistant.role !== 'assistant' ||
    isInterrupted(assistant) ||
    !user ||
    user.role !== 'user'
  )
    return null;
  return { assistant, user, history: messages.slice(0, assistantIndex - 1) };
}

export function editContext(messages: Conversation['messages'], userId: string) {
  const userIndex = messages.findIndex(({ id }) => id === userId);
  const user = messages[userIndex];
  if (!user || user.role !== 'user') return null;
  return {
    user,
    history: messages.slice(0, userIndex),
    replacedAssistant:
      messages[userIndex + 1]?.role === 'assistant' ? messages[userIndex + 1] : null,
  };
}

export function turnReplayDisposition(status: string): 'active' | 'replay' | 'blocked' {
  if (status === 'streaming') return 'active';
  if (status === 'completed' || status === 'cancelled') return 'replay';
  return 'blocked';
}

export async function personaFor(db: D1Database, ownerId: string, id: string): Promise<Persona> {
  const builtin = id
    ? DEFAULT_PERSONAS.find((persona) => persona.id === id)
    : DEFAULT_PERSONAS.find((persona) => persona.id === 'thinking-partner');
  if (builtin) return builtin;
  const persona = await loadPersona(db, ownerId, id);
  if (!persona) throw new HttpError(404, 'Persona not found');
  return persona;
}

export async function batchIfAny(db: D1Database, statements: D1PreparedStatement[]) {
  if (statements.length > 0) await db.batch(statements);
}

export type PreviousTurn = {
  id: string;
  status: string;
  created_at: string;
  branch_id: string;
};

export type NoteRow = {
  id: string;
  markdown: string;
  revision: number;
  provenance_json: string;
  created_at: string;
  updated_at: string;
};
