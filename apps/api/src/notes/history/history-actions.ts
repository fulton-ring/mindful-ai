import { noteHistoryActionSchema } from '@walden/contracts';
import type { z } from 'zod';
import { first, parseJson } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import { HttpError, nowIso } from '../../http';
import {
  assertReplayMatches,
  loadOperationRequest,
  runIdempotentBatch,
  type SuggestionChange,
} from '../operations';
import { loadNoteState } from './history';

type HistoryDirection = 'undo' | 'redo';
type HistoryInput = z.infer<typeof noteHistoryActionSchema>;
type HistoryEdit = {
  id: string;
  before_markdown: string;
  before_provenance_json: string;
  after_markdown: string;
  after_provenance_json: string;
  suggestion_changes_json: string | null;
};
type HistoryMove = {
  direction: HistoryDirection;
  input: HistoryInput;
  edit: HistoryEdit;
  revision: number;
  expectedMarkdown: string;
  markdown: string;
  provenance: string;
  changes: SuggestionChange[];
};

async function loadHistoryEdit(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  direction: HistoryDirection,
) {
  const undo = direction === 'undo';
  const edit = await first<HistoryEdit>(
    db
      .prepare(
        `SELECT id,before_markdown,before_provenance_json,after_markdown,after_provenance_json,suggestion_changes_json
       FROM note_edits WHERE note_id=? AND owner_id=? AND undone=? AND discarded=0 ORDER BY result_revision ${undo ? 'DESC' : 'ASC'} LIMIT 1`,
      )
      .bind(noteId, ownerId, undo ? 0 : 1),
  );
  if (!edit) throw new HttpError(409, `Nothing to ${direction}`);
  return edit;
}

function readSuggestionChanges(edit: HistoryEdit) {
  return parseJson<SuggestionChange[]>(edit.suggestion_changes_json ?? '', []);
}

async function assertSuggestionStatuses(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  direction: HistoryDirection,
  changes: SuggestionChange[],
) {
  const statuses = await Promise.all(
    changes.map((change) =>
      first<{ status: string }>(
        db
          .prepare('SELECT status FROM note_suggestions WHERE id=? AND note_id=? AND owner_id=?')
          .bind(change.id, noteId, ownerId),
      ),
    ),
  );
  const undo = direction === 'undo';
  const changed = statuses.some((suggestion, index) => {
    const change = changes[index];
    return suggestion?.status !== (undo ? change?.afterStatus : change?.beforeStatus);
  });
  if (changed) throw new HttpError(409, 'Note history changed');
}

const buildHistoryStatements = (
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  move: HistoryMove,
  now: string,
) => {
  const undo = move.direction === 'undo';
  const request = db
    .prepare(
      'INSERT INTO note_history_requests (owner_id,note_id,operation_id,action,base_revision,edit_id,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=? AND markdown=?) AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=? AND undone=? AND discarded=0)',
    )
    .bind(
      ownerId,
      noteId,
      move.input.operationId,
      move.direction,
      move.revision,
      move.edit.id,
      now,
      noteId,
      ownerId,
      move.revision,
      move.expectedMarkdown,
      move.edit.id,
      ownerId,
      undo ? 0 : 1,
    );
  const edit = db
    .prepare(
      'UPDATE note_edits SET undone=? WHERE id=? AND owner_id=? AND undone=? AND discarded=0 AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=? AND markdown=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)',
    )
    .bind(
      undo ? 1 : 0,
      move.edit.id,
      ownerId,
      undo ? 0 : 1,
      noteId,
      ownerId,
      move.revision,
      move.expectedMarkdown,
      ownerId,
      noteId,
      move.input.operationId,
      move.edit.id,
    );
  const note = db
    .prepare(
      'UPDATE notes SET markdown=?,provenance_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=? AND undone=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)',
    )
    .bind(
      move.markdown,
      move.provenance,
      now,
      noteId,
      ownerId,
      move.revision,
      move.edit.id,
      ownerId,
      undo ? 1 : 0,
      ownerId,
      noteId,
      move.input.operationId,
      move.edit.id,
    );
  return [request, edit, note, ...buildSuggestionUpdates(db, ownerId, noteId, move, now)];
};

const buildSuggestionUpdates = (
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  move: HistoryMove,
  now: string,
) =>
  move.changes.map((change) => {
    const undo = move.direction === 'undo';
    const status = undo ? change.beforeStatus : change.afterStatus;
    const expected = undo ? change.afterStatus : change.beforeStatus;
    return db
      .prepare(
        'UPDATE note_suggestions SET status=?,updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status=? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=? AND undone=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)',
      )
      .bind(
        status,
        now,
        change.id,
        noteId,
        ownerId,
        expected,
        move.edit.id,
        ownerId,
        undo ? 1 : 0,
        ownerId,
        noteId,
        move.input.operationId,
        move.edit.id,
      );
  });

async function runHistoryBatch(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  move: HistoryMove,
) {
  const statements = buildHistoryStatements(db, ownerId, noteId, move, nowIso());
  await runIdempotentBatch(db, statements, {
    key: { ownerId, noteId, operationId: move.input.operationId },
    expected: { action: move.direction, baseRevision: move.input.baseRevision },
    checked: statements.length,
    conflict: 'Note history changed',
  });
}

async function moveNoteHistoryInTransaction(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  direction: HistoryDirection,
  input: HistoryInput,
) {
  const replay = await loadOperationRequest(db, {
    ownerId,
    noteId,
    operationId: input.operationId,
  });
  if (replay) {
    assertReplayMatches(replay, { action: direction, baseRevision: input.baseRevision });
    return loadNoteState(db, ownerId, noteId);
  }
  const state = await loadNoteState(db, ownerId, noteId);
  if (state.note.revision !== input.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: state.note.revision });
  const edit = await loadHistoryEdit(db, ownerId, noteId, direction);
  const undo = direction === 'undo';
  const expectedMarkdown = undo ? edit.after_markdown : edit.before_markdown;
  if (state.note.markdown !== expectedMarkdown) throw new HttpError(409, 'Note history diverged');
  const changes = readSuggestionChanges(edit);
  await assertSuggestionStatuses(db, ownerId, noteId, direction, changes);
  await runHistoryBatch(db, ownerId, noteId, {
    direction,
    input,
    edit,
    revision: state.note.revision,
    expectedMarkdown,
    markdown: undo ? edit.before_markdown : edit.after_markdown,
    provenance: undo ? edit.before_provenance_json : edit.after_provenance_json,
    changes,
  });
  return loadNoteState(db, ownerId, noteId);
}

export async function moveNoteHistory(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  direction: HistoryDirection,
  input: HistoryInput,
) {
  return db.transaction
    ? db.transaction(
        (connection) => moveNoteHistoryInTransaction(connection, ownerId, noteId, direction, input),
        [`owner:${ownerId}`],
      )
    : moveNoteHistoryInTransaction(db, ownerId, noteId, direction, input);
}
