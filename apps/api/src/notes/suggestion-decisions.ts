import { type NoteState, noteDecisionSchema } from '@walden/contracts';
import { applyAgentProvenance, soleInsertion } from '@walden/domain';
import type { z } from 'zod';
import { first } from '../db/client';
import { HttpError, newId, nowIso } from '../http';
import { applySuggestionPatch, loadNoteState } from './history';
import { loadNoteAdditionQueue, SELECT_SUGGESTION, type SuggestionRow } from './suggestions';

type DecisionInput = z.infer<typeof noteDecisionSchema>;
type DecisionContext = {
  input: DecisionInput;
  state: NoteState;
  suggestion: SuggestionRow & { base_markdown: string };
  after: { markdown: string; provenance: NoteState['note']['provenance'] };
};

const decisionAction = (input: DecisionInput, suggestionId: string) =>
  `${input.decision}:${suggestionId}`;

const loadDecisionRequest = (
  db: D1Database,
  ownerId: string,
  noteId: string,
  operationId: string,
) =>
  first<{ action: string; base_revision: number }>(
    db
      .prepare(
        'SELECT action,base_revision FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=?',
      )
      .bind(ownerId, noteId, operationId),
  );

async function loadDecisionReplay(
  db: D1Database,
  ownerId: string,
  noteId: string,
  input: DecisionInput,
  suggestionId: string,
) {
  const replay = await loadDecisionRequest(db, ownerId, noteId, input.operationId);
  if (!replay) return false;
  if (
    replay.action !== decisionAction(input, suggestionId) ||
    replay.base_revision !== input.baseRevision
  )
    throw new HttpError(409, 'Operation ID was already used');
  return true;
}

async function loadPendingSuggestion(
  db: D1Database,
  ownerId: string,
  noteId: string,
  suggestionId: string,
) {
  const suggestion = await first<SuggestionRow & { base_markdown: string }>(
    db
      .prepare(`${SELECT_SUGGESTION} WHERE id=? AND note_id=? AND owner_id=?`)
      .bind(suggestionId, noteId, ownerId),
  );
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion is no longer pending');
  return suggestion;
}

async function decideNoteContent(
  db: D1Database,
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
  db: D1Database,
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
        `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,kind,suggestion_id,before_suggestion_status,after_suggestion_status,created_at)
       SELECT ?,n.id,n.owner_id,?,n.revision,n.revision+1,?,n.markdown,n.provenance_json,?,?,?,?,?,'pending',?,? FROM notes n JOIN note_suggestions s ON s.note_id=n.id AND s.owner_id=n.owner_id
       WHERE n.id=? AND n.owner_id=? AND n.revision=? AND n.markdown=? AND s.id=? AND s.status='pending'
       AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=n.owner_id AND note_id=n.id AND operation_id=? AND edit_id=?)`,
      )
      .bind(
        editId,
        input.operationId,
        state.note.title,
        state.note.title,
        after.markdown,
        afterProvenance,
        `suggestion_${input.decision}`,
        suggestion.id,
        status,
        now,
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
  db: D1Database,
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
        "UPDATE note_suggestions SET status=?,decision_edit_id=?,decided_at=?,updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status='pending' AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)",
      )
      .bind(status, editId, now, now, suggestion.id, noteId, ownerId, editId, ownerId),
    db
      .prepare(
        'UPDATE note_edits SET discarded=1 WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 AND id<>? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      )
      .bind(noteId, ownerId, editId, editId, ownerId),
  ];
};

const buildDecisionStatements = (
  db: D1Database,
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
  db: D1Database,
  ownerId: string,
  noteId: string,
  context: DecisionContext,
) {
  try {
    const results = await db.batch(
      buildDecisionStatements(db, ownerId, noteId, context, newId(), nowIso()),
    );
    if (results.slice(0, 4).some((result) => result.meta.changes !== 1))
      throw new HttpError(409, 'Note or suggestion changed');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const replayed = await loadDecisionRequest(db, ownerId, noteId, context.input.operationId);
    const matches =
      replayed?.action === decisionAction(context.input, context.suggestion.id) &&
      replayed.base_revision === context.input.baseRevision;
    if (!matches) throw new HttpError(409, 'Note or suggestion changed');
  }
}

export async function decideSuggestion(
  db: D1Database,
  ownerId: string,
  noteId: string,
  suggestionId: string,
  input: DecisionInput,
) {
  if (await loadDecisionReplay(db, ownerId, noteId, input, suggestionId))
    return loadNoteState(db, ownerId, noteId);
  const state = await loadNoteState(db, ownerId, noteId);
  if (input.decision !== 'accept' && state.note.revision !== input.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: state.note.revision });
  const suggestion = await loadPendingSuggestion(db, ownerId, noteId, suggestionId);
  const after = await decideNoteContent(db, ownerId, noteId, input, state, suggestion);
  await runDecisionBatch(db, ownerId, noteId, { input, state, suggestion, after });
  return loadNoteState(db, ownerId, noteId);
}
