import {
  type ChatEvent,
  type Conversation,
  DEFAULT_PERSONAS,
  type Persona,
} from '@walden/contracts';
import { first } from '../db/client';
import { HttpError } from '../http';

// Five-minute generation budget plus 15 seconds for terminal cleanup.
const ORPHANED_TURN_AFTER_MS = 315_000;
const encoder = new TextEncoder();

export const NEXT_USER_SEQUENCE_SQL =
  "SELECT COALESCE(MAX(sequence + CASE WHEN role='user' THEN 1 ELSE 0 END),0)+1 AS sequence FROM messages WHERE conversation_id=?";
export const REGENERATE_ASSISTANT_SQL =
  "UPDATE messages SET id=?,turn_id=?,content=?,reasoning=?,activity_json=?,incomplete=0,created_at=? WHERE id=? AND conversation_id=? AND owner_id=? AND role='assistant' AND incomplete=0 AND sequence=(SELECT MAX(sequence) FROM messages WHERE conversation_id=? AND owner_id=?)";

export function sse(event: ChatEvent) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function regenerationContext(messages: Conversation['messages'], assistantId: string) {
  const assistantIndex = messages.findIndex(({ id }) => id === assistantId);
  const assistant = messages[assistantIndex];
  const user = messages[assistantIndex - 1];
  if (
    !assistant ||
    assistant.id !== assistantId ||
    assistant.role !== 'assistant' ||
    assistant.incomplete ||
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

export function turnReplayDisposition(
  status: string,
  createdAt: string,
  now = Date.now(),
): 'active' | 'recover' | 'replay' | 'blocked' {
  if (status === 'streaming') {
    const age = now - Date.parse(createdAt);
    return Number.isFinite(age) && age > ORPHANED_TURN_AFTER_MS ? 'recover' : 'active';
  }
  if (status === 'completed' || status === 'cancelled') return 'replay';
  return 'blocked';
}

export function conversationStreamingDisposition(
  createdAt: string,
  now = Date.now(),
): 'active' | 'recover' {
  const disposition = turnReplayDisposition('streaming', createdAt, now);
  return disposition === 'recover' ? 'recover' : 'active';
}

export async function personaFor(db: D1Database, ownerId: string, id: string): Promise<Persona> {
  const builtin = id
    ? DEFAULT_PERSONAS.find((persona) => persona.id === id)
    : DEFAULT_PERSONAS.find((persona) => persona.id === 'thinking-partner');
  if (builtin) return builtin;
  const row = await first<Persona>(
    db
      .prepare(
        'SELECT id,name,prompt,brevity,challenge,tone,revision FROM personas WHERE id=? AND owner_id=?',
      )
      .bind(id, ownerId),
  );
  if (!row) throw new HttpError(404, 'Persona not found');
  return row;
}

export function createDurableStream(
  run: (output: ReadableStreamDefaultController<Uint8Array>) => Promise<void>,
  cancel: () => void,
  waitUntil: (task: Promise<void>) => void,
) {
  return new ReadableStream<Uint8Array>({
    start(output) {
      const lifecycle = run(output);
      waitUntil(lifecycle);
    },
    cancel,
  });
}

export async function batchIfAny(db: D1Database, statements: D1PreparedStatement[]) {
  if (statements.length > 0) await db.batch(statements);
}

export type ReplayMessage = {
  id: string;
  content: string;
  reasoning: string | null;
  created_at: string;
  incomplete: number;
  activity_json: string;
};

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
