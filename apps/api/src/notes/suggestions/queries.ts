import type { NoteSuggestion } from '@walden/contracts';
import { all, first } from '../../db/client';

export type SuggestionRow = {
  id: string;
  note_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  base_revision: number;
  old_text: string;
  new_text: string;
  reason: string;
  status: NoteSuggestion['status'];
  created_at: string;
  updated_at: string;
};

export const toNoteSuggestion = (row: SuggestionRow): NoteSuggestion => ({
  id: row.id,
  noteId: row.note_id,
  conversationId: row.conversation_id,
  sourceMessageId: row.source_message_id,
  baseRevision: row.base_revision,
  oldText: row.old_text,
  newText: row.new_text,
  reason: row.reason,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const SELECT_SUGGESTION =
  'SELECT id,note_id,conversation_id,source_message_id,base_revision,old_text,new_text,reason,status,created_at,updated_at FROM note_suggestions';

export async function loadNoteSuggestionBySource(
  db: D1Database,
  input: {
    ownerId: string;
    conversationId: string;
    branchId: string;
    sourceMessageId: string;
    generationKey?: string;
  },
): Promise<NoteSuggestion | null> {
  const row = await first<SuggestionRow>(
    db
      .prepare(
        `${SELECT_SUGGESTION} WHERE owner_id=? AND conversation_id=? AND branch_id=? AND generation_key=?
         ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
      )
      .bind(
        input.ownerId,
        input.conversationId,
        input.branchId,
        input.generationKey ?? input.sourceMessageId,
      ),
  );
  return row ? toNoteSuggestion(row) : null;
}

export async function loadNoteSuggestionBatch(
  db: D1Database,
  input: { ownerId: string; conversationId: string; branchId: string; generationKey: string },
): Promise<NoteSuggestion[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY generation_key
         ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, updated_at DESC
       ) AS generation_rank
       FROM note_suggestions
       WHERE owner_id=? AND conversation_id=? AND branch_id=? AND generation_key IN (?,?,?)
     ) WHERE generation_rank=1 ORDER BY generation_key`,
    )
    .bind(
      input.ownerId,
      input.conversationId,
      input.branchId,
      input.generationKey,
      `${input.generationKey}:operation:1`,
      `${input.generationKey}:operation:2`,
    )
    .all<SuggestionRow>();
  return rows.results.map(toNoteSuggestion);
}

/** Pending suggestions on a note, oldest first, so a turn can supersede its own earlier work. */
export async function loadPendingNoteSuggestions(
  db: D1Database,
  ownerId: string,
  noteId: string,
): Promise<NoteSuggestion[]> {
  // Superseding is an enhancement, never a precondition: if this lookup cannot
  // run, the turn should still produce its proposal rather than fail outright.
  try {
    const rows = await db
      .prepare(
        `${SELECT_SUGGESTION} WHERE owner_id=? AND note_id=? AND status='pending' ORDER BY created_at, id`,
      )
      .bind(ownerId, noteId)
      .all<SuggestionRow>();
    return (rows?.results ?? []).map(toNoteSuggestion);
  } catch {
    return [];
  }
}

/**
 * The note's additions in the order they were made, accepted ones included.
 * Accepting one out of order has to leave the others where the reader saw them,
 * which is only possible if the whole order is known. Accepting depends on it,
 * so a failed lookup fails the decision instead of placing text blind.
 */
export async function loadNoteAdditionQueue(
  db: D1Database,
  ownerId: string,
  noteId: string,
): Promise<Array<{ id: string; text: string; accepted: boolean }>> {
  const rows = await all<{ id: string; new_text: string; status: string }>(
    db
      .prepare(
        `SELECT id,new_text,status FROM note_suggestions
         WHERE owner_id=? AND note_id=? AND old_text='' AND status IN ('pending','accepted')
         ORDER BY created_at, id`,
      )
      .bind(ownerId, noteId),
  );
  return rows.map((row) => ({
    id: row.id,
    text: row.new_text,
    accepted: row.status === 'accepted',
  }));
}
