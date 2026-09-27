import type { EditProposal, NoteSuggestion } from '@walden/contracts';
import { first } from '../../db/client';
import { HttpError, newId, nowIso } from '../../http';
import { insertNoteStatement } from '../repository';
import { loadNoteSuggestionBySource } from './queries';

export { cancelNoteSuggestionAttempt } from './cancellation';
export {
  loadNoteAdditionQueue,
  loadNoteSuggestionBatch,
  loadNoteSuggestionBySource,
  loadPendingNoteSuggestions,
} from './queries';

type PersistNoteSuggestionInput = {
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
};

type SuggestionBaseline = {
  note_id: string | null;
  title: string;
  markdown: string | null;
  revision: number | null;
};

const INSERT_SUGGESTION = `INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,base_revision,old_text,new_text,reason,status,created_at,updated_at,branch_id,generation_key)
     SELECT ?,?,?,?,?,?,?,?,?,'pending',?,?,?,? WHERE NOT EXISTS (
       SELECT 1 FROM note_suggestion_cancellations WHERE owner_id=? AND attempt_id=?
     ) AND EXISTS (
       SELECT 1 FROM notes n JOIN conversations c ON c.note_id=n.id AND c.owner_id=n.owner_id
       JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
       WHERE n.id=? AND n.owner_id=? AND n.revision=? AND n.markdown=? AND c.id=?
       AND b.id=? AND b.status='active' AND c.expires_at>?
       AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id
         AND m.owner_id=c.owner_id AND m.role='assistant' AND json_extract(m.ui_message,'$.metadata.status') IS NOT 'interrupted')
     )`;

// A proposal on a conversation without a note creates the note, titled after the conversation.
const NEW_NOTE_GUARD = `NOT EXISTS (
           SELECT 1 FROM note_suggestion_cancellations WHERE owner_id=? AND attempt_id=?
         ) AND EXISTS (
           SELECT 1 FROM conversations c JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
           WHERE c.id=? AND c.owner_id=? AND c.note_id IS NULL AND b.id=?
           AND b.status='active' AND c.expires_at>?
           AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id
             AND m.owner_id=c.owner_id AND m.role='assistant' AND json_extract(m.ui_message,'$.metadata.status') IS NOT 'interrupted')
         )`;

type SuggestionInsertContext = {
  input: PersistNoteSuggestionInput;
  baseline: SuggestionBaseline;
  noteId: string;
  now: string;
};

async function loadSuggestionBaseline(
  db: D1Database,
  input: PersistNoteSuggestionInput,
): Promise<SuggestionBaseline | null> {
  return first<SuggestionBaseline>(
    db
      .prepare(
        `SELECT c.note_id,c.title,n.markdown,n.revision FROM conversations c
         JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
         LEFT JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id
         WHERE c.id=? AND c.owner_id=? AND b.id=? AND b.status='active' AND c.expires_at>?
         AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id
           AND m.owner_id=c.owner_id AND m.role='assistant' AND json_extract(m.ui_message,'$.metadata.status') IS NOT 'interrupted')`,
      )
      .bind(input.conversationId, input.ownerId, input.branchId, nowIso(), input.sourceMessageId),
  );
}

function assertSuggestionBaseline(
  baseline: SuggestionBaseline | null,
  input: PersistNoteSuggestionInput,
): asserts baseline is SuggestionBaseline {
  if (
    !baseline ||
    baseline.note_id !== input.expectedNoteId ||
    (baseline.revision ?? null) !== input.expectedRevision
  )
    throw new HttpError(409, 'Conversation or note changed');
}

function prepareSuggestionInsert(
  db: D1Database,
  context: SuggestionInsertContext,
): D1PreparedStatement {
  const { input, baseline, noteId, now } = context;
  return db
    .prepare(INSERT_SUGGESTION)
    .bind(
      input.proposal.id,
      noteId,
      input.ownerId,
      input.conversationId,
      input.sourceMessageId,
      baseline.revision ?? 0,
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
      baseline.markdown ?? '',
      input.conversationId,
      input.branchId,
      now,
      input.sourceMessageId,
    );
}

/** A failed insert is fine when a concurrent attempt already stored this proposal. */
async function replayAfterSuggestionInsertFailure(
  db: D1Database,
  input: PersistNoteSuggestionInput,
): Promise<NoteSuggestion> {
  const raced = await loadNoteSuggestionBySource(db, input);
  if (raced) return raced;
  throw new HttpError(409, 'Conversation or note changed');
}

async function insertSuggestionWithNote(
  db: D1Database,
  context: SuggestionInsertContext,
  suggestionInsert: D1PreparedStatement,
): Promise<NoteSuggestion | null> {
  const { input, baseline, noteId, now } = context;
  let results: D1Result[];
  try {
    results = await db.batch([
      insertNoteStatement(
        db,
        { id: noteId, ownerId: input.ownerId, now, title: baseline.title },
        {
          where: NEW_NOTE_GUARD,
          params: [
            input.ownerId,
            input.attemptId ?? input.proposal.id,
            input.conversationId,
            input.ownerId,
            input.branchId,
            now,
            input.sourceMessageId,
          ],
        },
      ),
      db
        .prepare(
          'UPDATE conversations SET note_id=? WHERE id=? AND owner_id=? AND note_id IS NULL AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=?)',
        )
        .bind(noteId, input.conversationId, input.ownerId, noteId, input.ownerId),
      suggestionInsert,
    ]);
  } catch {
    return replayAfterSuggestionInsertFailure(db, input);
  }
  if (results.some((result) => result.meta.changes !== 1))
    return replayAfterSuggestionInsertFailure(db, input);
  return null;
}

async function insertSuggestionOnNote(
  db: D1Database,
  input: PersistNoteSuggestionInput,
  suggestionInsert: D1PreparedStatement,
): Promise<NoteSuggestion | null> {
  let inserted: D1Result;
  try {
    inserted = await suggestionInsert.run();
  } catch {
    return replayAfterSuggestionInsertFailure(db, input);
  }
  if (inserted.meta.changes === 1) return null;
  return replayAfterSuggestionInsertFailure(db, input);
}

async function invalidateReplacedSuggestion(
  db: D1Database,
  input: PersistNoteSuggestionInput,
  noteId: string,
  now: string,
): Promise<void> {
  if (!input.proposal.replaces) return;
  await db
    .prepare(
      "UPDATE note_suggestions SET status='invalidated',updated_at=? WHERE id=? AND owner_id=? AND note_id=? AND status='pending'",
    )
    .bind(now, input.proposal.replaces, input.ownerId, noteId)
    .run();
}

export async function persistNoteSuggestion(
  db: D1Database,
  input: PersistNoteSuggestionInput,
): Promise<{ noteId: string; suggestion: NoteSuggestion; created: boolean }> {
  const replay = await loadNoteSuggestionBySource(db, input);
  if (replay && (!input.allowAfterDecision || replay.status === 'pending'))
    return { noteId: replay.noteId, suggestion: replay, created: false };
  const baseline = await loadSuggestionBaseline(db, input);
  assertSuggestionBaseline(baseline, input);
  const noteId = baseline.note_id ?? newId();
  const now = nowIso();
  const context = { input, baseline, noteId, now };
  const suggestionInsert = prepareSuggestionInsert(db, context);
  const raced = baseline.note_id
    ? await insertSuggestionOnNote(db, input, suggestionInsert)
    : await insertSuggestionWithNote(db, context, suggestionInsert);
  if (raced) return { noteId: raced.noteId, suggestion: raced, created: false };
  await invalidateReplacedSuggestion(db, input, noteId, now);
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
