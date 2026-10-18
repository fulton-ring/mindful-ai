import { type NoteState, noteDecisionSchema } from '@walden/contracts';
import { applyAgentProvenance, soleInsertion } from '@walden/domain';
import type { z } from 'zod';
import { first } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import { HttpError, newId, nowIso } from '../../http';
import { applySuggestionPatch, loadNoteState } from '../history/history';
import {
  assertReplayMatches,
  loadOperationRequest,
  runIdempotentBatch,
  type SuggestionChange,
} from '../operations';
import { loadNoteAdditionQueue, SELECT_SUGGESTION, type SuggestionRow } from './queries';

type DecisionInput = z.infer<typeof noteDecisionSchema>;
type DecisionContext = {
  input: DecisionInput;
  state: NoteState;
  suggestion: SuggestionRow;
  after: { markdown: string; provenance: NoteState['note']['provenance'] };
};

const decisionAction = (input: DecisionInput, suggestionId: string) =>
  `${input.decision}:${suggestionId}`;

async function loadPendingSuggestion(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  suggestionId: string,
) {
  const suggestion = await first<SuggestionRow>(
    db
      .prepare(`${SELECT_SUGGESTION} WHERE id=? AND note_id=? AND owner_id=?`)
      .bind(suggestionId, noteId, ownerId),
  );
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion is no longer pending');
  return suggestion;
}

async function decideNoteContent(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  input: DecisionInput,
  state: NoteState,
  suggestion: SuggestionRow,
) {
  if (input.decision === 'reject')
    return { markdown: state.note.markdown, provenance: state.note.provenance };
  const offered =
    suggestion.old_text === '' && input.markdown !== undefined
      ? soleInsertion(state.note.markdown, input.markdown)
      : null;
  const submitted = offered?.insert.trim() === suggestion.new_text.trim() ? offered : null;
  if (input.markdown !== undefined && suggestion.old_text === '' && !submitted)
    throw new HttpError(409, 'Suggestion preview changed. Refresh the note and review it again.');
  const after = submitted
    ? {
        markdown: input.markdown as string,
        provenance: applyAgentProvenance(state.note.provenance, submitted, suggestion.id),
      }
    : applySuggestionPatch(
        state.note,
        {
          id: suggestion.id,
          oldText: suggestion.old_text,
          newText: suggestion.new_text,
          reason: suggestion.reason,
        },
        await loadNoteAdditionQueue(db, ownerId, noteId),
      );
  if (input.markdown !== undefined && after.markdown !== input.markdown)
    throw new HttpError(409, 'Suggestion preview changed. Refresh the note and review it again.');
  return after;
}

const buildDecisionCreates = (
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  context: DecisionContext,
  editId: string,
  now: string,
) => {
  const { input, state, suggestion, after } = context;
  const status = input.decision === 'accept' ? 'accepted' : 'dismissed';
  const afterProvenance = JSON.stringify(after.provenance);
  return [
    db
      .prepare(
        "INSERT INTO note_history_requests (owner_id,note_id,operation_id,action,base_revision,edit_id,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM notes n JOIN note_suggestions s ON s.note_id=n.id AND s.owner_id=n.owner_id WHERE n.id=? AND n.owner_id=? AND n.revision=? AND n.markdown=? AND s.id=? AND s.status='pending')",
      )
      .bind(
        ownerId,
        noteId,
        input.operationId,
        decisionAction(input, suggestion.id),
        input.baseRevision,
        editId,
        now,
        noteId,
        ownerId,
        state.note.revision,
        state.note.markdown,
        suggestion.id,
      ),
    db
      .prepare(
        `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_markdown,before_provenance_json,after_markdown,after_provenance_json,created_at,suggestion_changes_json)
       SELECT ?,n.id,n.owner_id,?,n.revision,n.revision+1,n.markdown,n.provenance_json,?,?,?,? FROM notes n JOIN note_suggestions s ON s.note_id=n.id AND s.owner_id=n.owner_id
       WHERE n.id=? AND n.owner_id=? AND n.revision=? AND n.markdown=? AND s.id=? AND s.status='pending'
       AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=n.owner_id AND note_id=n.id AND operation_id=? AND edit_id=?)`,
      )
      .bind(
        editId,
        input.operationId,
        after.markdown,
        afterProvenance,
        now,
        JSON.stringify([
          { id: suggestion.id, beforeStatus: 'pending', afterStatus: status },
        ] satisfies SuggestionChange[]),
        noteId,
        ownerId,
        state.note.revision,
        state.note.markdown,
        suggestion.id,
        input.operationId,
        editId,
      ),
  ];
};

const buildDecisionUpdates = (
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  context: DecisionContext,
  editId: string,
  now: string,
) => {
  const { input, state, suggestion, after } = context;
  const status = input.decision === 'accept' ? 'accepted' : 'dismissed';
  return [
    db
      .prepare(
        'UPDATE notes SET markdown=?,provenance_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      )
      .bind(
        after.markdown,
        JSON.stringify(after.provenance),
        now,
        noteId,
        ownerId,
        state.note.revision,
        editId,
        ownerId,
      ),
    db
      .prepare(
        "UPDATE note_suggestions SET status=?,updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status='pending' AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)",
      )
      .bind(status, now, suggestion.id, noteId, ownerId, editId, ownerId),
    db
      .prepare(
        'UPDATE note_edits SET discarded=1 WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 AND id<>? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      )
      .bind(noteId, ownerId, editId, editId, ownerId),
  ];
};

const buildDecisionStatements = (
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  context: DecisionContext,
  editId: string,
  now: string,
) => [
  ...buildDecisionCreates(db, ownerId, noteId, context, editId, now),
  ...buildDecisionUpdates(db, ownerId, noteId, context, editId, now),
];

async function runDecisionBatch(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  context: DecisionContext,
) {
  await runIdempotentBatch(
    db,
    buildDecisionStatements(db, ownerId, noteId, context, newId(), nowIso()),
    {
      key: { ownerId, noteId, operationId: context.input.operationId },
      expected: {
        action: decisionAction(context.input, context.suggestion.id),
        baseRevision: context.input.baseRevision,
      },
      // The history request, edit, note and suggestion rows; discarding redo may touch none.
      checked: 4,
      conflict: 'Note or suggestion changed',
    },
  );
}

async function decideSuggestionInTransaction(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  suggestionId: string,
  input: DecisionInput,
) {
  const replay = await loadOperationRequest(db, {
    ownerId,
    noteId,
    operationId: input.operationId,
  });
  if (replay) {
    assertReplayMatches(replay, {
      action: decisionAction(input, suggestionId),
      baseRevision: input.baseRevision,
    });
    return loadNoteState(db, ownerId, noteId);
  }
  const state = await loadNoteState(db, ownerId, noteId);
  if (input.decision !== 'accept' && state.note.revision !== input.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: state.note.revision });
  const suggestion = await loadPendingSuggestion(db, ownerId, noteId, suggestionId);
  const after = await decideNoteContent(db, ownerId, noteId, input, state, suggestion);
  await runDecisionBatch(db, ownerId, noteId, { input, state, suggestion, after });
  return loadNoteState(db, ownerId, noteId);
}

export async function decideSuggestion(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  suggestionId: string,
  input: DecisionInput,
) {
  return db.transaction
    ? db.transaction(
        (connection) =>
          decideSuggestionInTransaction(connection, ownerId, noteId, suggestionId, input),
        [`owner:${ownerId}`],
      )
    : decideSuggestionInTransaction(db, ownerId, noteId, suggestionId, input);
}
