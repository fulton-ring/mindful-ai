import { first } from '../../db/client';
import { HttpError, newId, nowIso } from '../../http';
import { dismissChange, hasNoteEdit } from '../operations';

type CancelSuggestionInput = {
  ownerId: string;
  conversationId: string;
  branchId: string;
  sourceMessageId: string;
  attemptId: string;
};

type PendingSuggestion = { id: string; note_id: string };

async function markSuggestionAttemptCancelled(
  db: D1Database,
  input: CancelSuggestionInput,
  now: string,
): Promise<void> {
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
  if (marker.meta.changes === 1) return;
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

async function loadPendingSuggestions(
  db: D1Database,
  input: CancelSuggestionInput,
): Promise<PendingSuggestion[]> {
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
    .all<PendingSuggestion>();
  return pending.results;
}

const INSERT_CANCELLATION_EDIT = (ids: string[]) => `INSERT INTO note_edits
       (id,note_id,owner_id,operation_id,base_revision,result_revision,before_markdown,before_provenance_json,after_markdown,after_provenance_json,created_at,suggestion_changes_json)
       SELECT ?,n.id,n.owner_id,?,n.revision,n.revision+1,n.markdown,n.provenance_json,n.markdown,n.provenance_json,?,?
       FROM notes n JOIN conversations c ON c.note_id=n.id AND c.owner_id=n.owner_id
       WHERE n.id=? AND n.owner_id=? AND c.id=?
         AND (SELECT COUNT(*) FROM note_suggestions WHERE note_id=n.id AND owner_id=n.owner_id AND status='pending' AND id IN (${ids.map(() => '?').join(',')}))=?`;

async function applySuggestionCancellation(
  db: D1Database,
  input: CancelSuggestionInput,
  now: string,
  noteId: string,
  ids: string[],
): Promise<void> {
  const operationId = `cancel:${input.attemptId}`;
  const editId = newId();
  const changes = ids.map(dismissChange);
  const edit = db
    .prepare(INSERT_CANCELLATION_EDIT(ids))
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
          "UPDATE note_suggestions SET status='dismissed',updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status='pending' AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)",
        )
        .bind(now, id, noteId, input.ownerId, editId, input.ownerId),
    ),
    db
      .prepare(
        'UPDATE note_edits SET discarded=1 WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 AND id<>? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      )
      .bind(noteId, input.ownerId, editId, editId, input.ownerId),
  ]);
  if (results.slice(0, 2 + ids.length).some((result) => result.meta.changes !== 1))
    throw new HttpError(409, 'Suggestion batch changed');
}

export async function cancelNoteSuggestionAttempt(
  db: D1Database,
  input: CancelSuggestionInput,
): Promise<{ noteId: string | null; cancelledSuggestionIds: string[] }> {
  const now = nowIso();
  await markSuggestionAttemptCancelled(db, input, now);
  const pending = await loadPendingSuggestions(db, input);
  if (!pending.length) return { noteId: null, cancelledSuggestionIds: [] };
  const noteId = pending[0]!.note_id;
  if (pending.some((suggestion) => suggestion.note_id !== noteId))
    throw new HttpError(409, 'Suggestion batch changed');
  const operationId = `cancel:${input.attemptId}`;
  if (await hasNoteEdit(db, { ownerId: input.ownerId, noteId, operationId }))
    return { noteId, cancelledSuggestionIds: [] };
  const ids = pending.map(({ id }) => id);
  await applySuggestionCancellation(db, input, now, noteId, ids);
  return { noteId, cancelledSuggestionIds: ids };
}
