import type { EditProposal, NoteSuggestion } from '@walden/contracts';
import { first } from '../db/client';
import { HttpError, newId, nowIso } from '../http';

type SuggestionRow = {
  id: string;
  note_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  base_markdown: string;
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

const SELECT_SUGGESTION =
  'SELECT id,note_id,conversation_id,source_message_id,base_revision,base_markdown,old_text,new_text,reason,status,created_at,updated_at FROM note_suggestions';

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

export async function persistNoteSuggestion(
  db: D1Database,
  input: {
    ownerId: string;
    conversationId: string;
    branchId: string;
    sourceMessageId: string;
    generationKey?: string;
    expectedNoteId: string | null;
    expectedRevision: number | null;
    proposal: EditProposal;
    attemptId?: string;
    allowAfterDecision?: boolean;
  },
): Promise<{ noteId: string; suggestion: NoteSuggestion; created: boolean }> {
  const replay = await loadNoteSuggestionBySource(db, input);
  if (replay && (!input.allowAfterDecision || replay.status === 'pending'))
    return { noteId: replay.noteId, suggestion: replay, created: false };
  const baseline = await first<{
    note_id: string | null;
    markdown: string | null;
    revision: number | null;
  }>(
    db
      .prepare(
        `SELECT c.note_id,n.markdown,n.revision FROM conversations c
         JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
         LEFT JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id
         WHERE c.id=? AND c.owner_id=? AND b.id=? AND b.status='active' AND b.expires_at>?
         AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id
           AND m.owner_id=c.owner_id AND m.role='assistant' AND m.incomplete=0)`,
      )
      .bind(input.conversationId, input.ownerId, input.branchId, nowIso(), input.sourceMessageId),
  );
  if (
    !baseline ||
    baseline.note_id !== input.expectedNoteId ||
    (baseline.revision ?? null) !== input.expectedRevision
  )
    throw new HttpError(409, 'Conversation or note changed');
  const noteId = baseline.note_id ?? newId();
  const now = nowIso();
  const baseMarkdown = baseline.markdown ?? '';
  const suggestionInsert = db
    .prepare(
      `INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,base_revision,base_markdown,old_text,new_text,reason,status,created_at,updated_at,branch_id,generation_key)
     SELECT ?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,? WHERE NOT EXISTS (
       SELECT 1 FROM note_suggestion_cancellations WHERE owner_id=? AND attempt_id=?
     ) AND EXISTS (
       SELECT 1 FROM notes n JOIN conversations c ON c.note_id=n.id AND c.owner_id=n.owner_id
       JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
       WHERE n.id=? AND n.owner_id=? AND n.revision=? AND n.markdown=? AND c.id=?
       AND b.id=? AND b.status='active' AND b.expires_at>?
       AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id
         AND m.owner_id=c.owner_id AND m.role='assistant' AND m.incomplete=0)
     )`,
    )
    .bind(
      input.proposal.id,
      noteId,
      input.ownerId,
      input.conversationId,
      input.sourceMessageId,
      baseline.revision ?? 0,
      baseMarkdown,
      input.proposal.oldText,
      input.proposal.newText,
      input.proposal.reason,
      now,
      now,
      input.branchId,
      input.generationKey ?? input.sourceMessageId,
      input.ownerId,
      input.attemptId ?? input.proposal.id,
      noteId,
      input.ownerId,
      baseline.revision ?? 0,
      baseMarkdown,
      input.conversationId,
      input.branchId,
      now,
      input.sourceMessageId,
    );
  if (!baseline.note_id) {
    let results: D1Result[];
    try {
      results = await db.batch([
        db
          .prepare(
            `INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title)
         SELECT ?,?,'',0,'[]',?,?,
           COALESCE((SELECT c.title FROM conversations c WHERE c.id=? AND c.owner_id=?),'')
         WHERE NOT EXISTS (
           SELECT 1 FROM note_suggestion_cancellations WHERE owner_id=? AND attempt_id=?
         ) AND EXISTS (
           SELECT 1 FROM conversations c JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
           WHERE c.id=? AND c.owner_id=? AND c.note_id IS NULL AND b.id=?
           AND b.status='active' AND b.expires_at>?
           AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id
             AND m.owner_id=c.owner_id AND m.role='assistant' AND m.incomplete=0)
         )`,
          )
          .bind(
            noteId,
            input.ownerId,
            now,
            now,
            input.conversationId,
            input.ownerId,
            input.ownerId,
            input.attemptId ?? input.proposal.id,
            input.conversationId,
            input.ownerId,
            input.branchId,
            now,
            input.sourceMessageId,
          ),
        db
          .prepare(
            'UPDATE conversations SET note_id=? WHERE id=? AND owner_id=? AND note_id IS NULL AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=?)',
          )
          .bind(noteId, input.conversationId, input.ownerId, noteId, input.ownerId),
        suggestionInsert,
      ]);
    } catch {
      const raced = await loadNoteSuggestionBySource(db, input);
      if (raced) return { noteId: raced.noteId, suggestion: raced, created: false };
      throw new HttpError(409, 'Conversation or note changed');
    }
    if (results.some((result) => result.meta.changes !== 1))
      throw new HttpError(409, 'Conversation or note changed');
  } else {
    let inserted: D1Result;
    try {
      inserted = await suggestionInsert.run();
    } catch {
      const raced = await loadNoteSuggestionBySource(db, input);
      if (raced) return { noteId: raced.noteId, suggestion: raced, created: false };
      throw new HttpError(409, 'Conversation or note changed');
    }
    if (inserted.meta.changes === 1) {
      // Persisted below.
    } else {
      const raced = await loadNoteSuggestionBySource(db, input);
      if (raced) return { noteId: raced.noteId, suggestion: raced, created: false };
      throw new HttpError(409, 'Conversation or note changed');
    }
  }
  // Supersede the proposal this one revises, once the new row is safely stored.
  // Deliberately after the insert rather than inside its all-or-nothing batch:
  // if the reader has already accepted or rejected the old suggestion this
  // changes nothing, and that benign no-op must not fail the new proposal.
  if (input.proposal.replaces)
    await db
      .prepare(
        "UPDATE note_suggestions SET status='invalidated',updated_at=? WHERE id=? AND owner_id=? AND note_id=? AND status='pending'",
      )
      .bind(now, input.proposal.replaces, input.ownerId, noteId)
      .run();
  return {
    noteId,
    created: true,
    suggestion: {
      ...input.proposal,
      noteId,
      status: 'pending',
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export async function cancelNoteSuggestionAttempt(
  db: D1Database,
  input: {
    ownerId: string;
    conversationId: string;
    branchId: string;
    sourceMessageId: string;
    attemptId: string;
  },
): Promise<{ noteId: string | null; cancelledSuggestionIds: string[] }> {
  const now = nowIso();
  const marker = await db
    .prepare(
      `INSERT OR IGNORE INTO note_suggestion_cancellations
       (owner_id,attempt_id,conversation_id,branch_id,source_message_id,created_at)
       SELECT ?,?,?,?,?,? WHERE EXISTS (
         SELECT 1 FROM conversations c
         JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
         JOIN messages m ON m.conversation_id=c.id AND m.owner_id=c.owner_id
         WHERE c.id=? AND c.owner_id=? AND b.id=? AND m.id=?
           AND m.role='assistant' AND m.incomplete=0
       )`,
    )
    .bind(
      input.ownerId,
      input.attemptId,
      input.conversationId,
      input.branchId,
      input.sourceMessageId,
      now,
      input.conversationId,
      input.ownerId,
      input.branchId,
      input.sourceMessageId,
    )
    .run();
  if (marker.meta.changes !== 1) {
    const existing = await first<{ attempt_id: string }>(
      db
        .prepare(
          'SELECT attempt_id FROM note_suggestion_cancellations WHERE owner_id=? AND attempt_id=? AND conversation_id=? AND branch_id=? AND source_message_id=?',
        )
        .bind(
          input.ownerId,
          input.attemptId,
          input.conversationId,
          input.branchId,
          input.sourceMessageId,
        ),
    );
    if (!existing) throw new HttpError(404, 'Completed response not found');
  }
  const pending = await db
    .prepare(
      `SELECT id,note_id FROM note_suggestions
       WHERE owner_id=? AND conversation_id=? AND branch_id=? AND source_message_id=? AND status='pending'
         AND (id=? OR substr(id,1,length(?)+1)=? || ':')
       ORDER BY id`,
    )
    .bind(
      input.ownerId,
      input.conversationId,
      input.branchId,
      input.sourceMessageId,
      input.attemptId,
      input.attemptId,
      input.attemptId,
    )
    .all<{ id: string; note_id: string }>();
  if (!pending.results.length) return { noteId: null, cancelledSuggestionIds: [] };
  const noteId = pending.results[0]!.note_id;
  if (pending.results.some((suggestion) => suggestion.note_id !== noteId))
    throw new HttpError(409, 'Suggestion batch changed');
  const operationId = `cancel:${input.attemptId}`;
  const priorCancellation = await first<{ id: string }>(
    db
      .prepare('SELECT id FROM note_edits WHERE note_id=? AND owner_id=? AND operation_id=?')
      .bind(noteId, input.ownerId, operationId),
  );
  if (priorCancellation) return { noteId, cancelledSuggestionIds: [] };
  const ids = pending.results.map(({ id }) => id);
  const editId = newId();
  const changes = ids.map((id) => ({ id, beforeStatus: 'pending', afterStatus: 'dismissed' }));
  const edit = db
    .prepare(
      `INSERT INTO note_edits
       (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,kind,suggestion_id,before_suggestion_status,after_suggestion_status,created_at,suggestion_changes_json)
       SELECT ?,n.id,n.owner_id,?,n.revision,n.revision+1,c.title,n.markdown,n.provenance_json,c.title,n.markdown,n.provenance_json,'user_edit',NULL,NULL,NULL,?,?
       FROM notes n JOIN conversations c ON c.note_id=n.id AND c.owner_id=n.owner_id
       WHERE n.id=? AND n.owner_id=? AND c.id=?
         AND (SELECT COUNT(*) FROM note_suggestions WHERE note_id=n.id AND owner_id=n.owner_id AND status='pending' AND id IN (${ids.map(() => '?').join(',')}))=?`,
    )
    .bind(
      editId,
      operationId,
      now,
      JSON.stringify(changes),
      noteId,
      input.ownerId,
      input.conversationId,
      ...ids,
      ids.length,
    );
  const results = await db.batch([
    edit,
    db
      .prepare(
        'UPDATE notes SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=(SELECT base_revision FROM note_edits WHERE id=? AND owner_id=?) AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      )
      .bind(now, noteId, input.ownerId, editId, input.ownerId, editId, input.ownerId),
    ...ids.map((id) =>
      db
        .prepare(
          "UPDATE note_suggestions SET status='dismissed',decision_edit_id=?,decided_at=?,updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status='pending' AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)",
        )
        .bind(editId, now, now, id, noteId, input.ownerId, editId, input.ownerId),
    ),
    db
      .prepare(
        'UPDATE note_edits SET discarded=1 WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 AND id<>? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      )
      .bind(noteId, input.ownerId, editId, editId, input.ownerId),
  ]);
  if (results.slice(0, 2 + ids.length).some((result) => result.meta.changes !== 1))
    throw new HttpError(409, 'Suggestion batch changed');
  return { noteId, cancelledSuggestionIds: ids };
}

export type { SuggestionRow };
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
 * which is only possible if the whole order is known.
 */
export async function loadNoteAdditionQueue(
  db: D1Database,
  ownerId: string,
  noteId: string,
): Promise<Array<{ id: string; text: string; accepted: boolean }>> {
  try {
    const rows = await db
      .prepare(
        `SELECT id,new_text,status FROM note_suggestions
         WHERE owner_id=? AND note_id=? AND old_text='' AND status IN ('pending','accepted')
         ORDER BY created_at, id`,
      )
      .bind(ownerId, noteId)
      .all<{ id: string; new_text: string; status: string }>();
    return (rows?.results ?? []).map((row) => ({
      id: row.id,
      text: row.new_text,
      accepted: row.status === 'accepted',
    }));
  } catch {
    return [];
  }
}

export { SELECT_SUGGESTION };
