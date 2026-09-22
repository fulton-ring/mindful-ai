import { noteHistoryActionSchema } from '@walden/contracts';
import type { z } from 'zod';
import { first, parseJson } from '../../db/client';
import { HttpError, nowIso } from '../../http';
import { loadNoteState } from './history';

type HistoryDirection = 'undo' | 'redo';
type HistoryInput = z.infer<typeof noteHistoryActionSchema>;
type SuggestionChange = { id: string; beforeStatus: string; afterStatus: string };
type HistoryEdit = {
  id: string;
  suggestion_id: string | null;
  before_markdown: string;
  before_provenance_json: string;
  after_markdown: string;
  after_provenance_json: string;
  before_suggestion_status: string | null;
  after_suggestion_status: string | null;
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

const loadHistoryRequest = (db: D1Database, ownerId: string, noteId: string, operationId: string) =>
  first<{ action: string; base_revision: number }>(
    db
      .prepare(
        'SELECT action,base_revision FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=?',
      )
      .bind(ownerId, noteId, operationId),
  );

async function isHistoryReplay(
  db: D1Database,
  ownerId: string,
  noteId: string,
  direction: HistoryDirection,
  input: HistoryInput,
) {
  const replay = await loadHistoryRequest(db, ownerId, noteId, input.operationId);
  if (!replay) return false;
  if (replay.action !== direction || replay.base_revision !== input.baseRevision)
    throw new HttpError(409, 'Operation ID was already used');
  return true;
}

async function loadHistoryEdit(
  db: D1Database,
  ownerId: string,
  noteId: string,
  direction: HistoryDirection,
) {
  const undo = direction === 'undo';
  const edit = await first<HistoryEdit>(
    db
      .prepare(
        `SELECT id,suggestion_id,before_markdown,before_provenance_json,after_markdown,after_provenance_json,before_suggestion_status,after_suggestion_status,suggestion_changes_json
       FROM note_edits WHERE note_id=? AND owner_id=? AND undone=? AND discarded=0 ORDER BY result_revision ${undo ? 'DESC' : 'ASC'} LIMIT 1`,
      )
      .bind(noteId, ownerId, undo ? 0 : 1),
  );
  if (!edit) throw new HttpError(409, `Nothing to ${direction}`);
  return edit;
}

function readSuggestionChanges(edit: HistoryEdit) {
  const legacy =
    edit.suggestion_id && edit.before_suggestion_status && edit.after_suggestion_status
      ? [
          {
            id: edit.suggestion_id,
            beforeStatus: edit.before_suggestion_status,
            afterStatus: edit.after_suggestion_status,
          },
        ]
      : [];
  return parseJson<SuggestionChange[]>(edit.suggestion_changes_json ?? '', legacy);
}

async function assertSuggestionStatuses(
  db: D1Database,
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

async function assertNoNewerSuggestions(
  db: D1Database,
  ownerId: string,
  noteId: string,
  changes: SuggestionChange[],
) {
  for (const change of changes) {
    if (change.beforeStatus !== 'pending') continue;
    const newer = await first<{ id: string }>(
      db
        .prepare(
          `SELECT newer.id FROM note_suggestions target
         JOIN note_suggestions newer ON newer.owner_id=target.owner_id
           AND newer.conversation_id=target.conversation_id
           AND newer.source_message_id=target.source_message_id
         WHERE target.id=? AND target.note_id=? AND target.owner_id=?
           AND newer.id<>target.id AND newer.status='pending'
           AND (newer.created_at>target.created_at OR (newer.created_at=target.created_at AND newer.id>target.id))
         LIMIT 1`,
        )
        .bind(change.id, noteId, ownerId),
    );
    if (newer)
      throw new HttpError(409, 'Resolve the newer note suggestion before undoing this decision.');
  }
}

const buildHistoryStatements = (
  db: D1Database,
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
      'UPDATE note_edits SET undone=?,undone_at=? WHERE id=? AND owner_id=? AND undone=? AND discarded=0 AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=? AND markdown=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)',
    )
    .bind(
      undo ? 1 : 0,
      undo ? now : null,
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
  db: D1Database,
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
        'UPDATE note_suggestions SET status=?,updated_at=?,decided_at=? WHERE id=? AND note_id=? AND owner_id=? AND status=? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=? AND undone=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)',
      )
      .bind(
        status,
        now,
        status === 'pending' ? null : now,
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

async function runHistoryBatch(db: D1Database, ownerId: string, noteId: string, move: HistoryMove) {
  try {
    const results = await db.batch(buildHistoryStatements(db, ownerId, noteId, move, nowIso()));
    if (results.some((result) => result.meta.changes !== 1))
      throw new HttpError(409, 'Note history changed');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const replayed = await loadHistoryRequest(db, ownerId, noteId, move.input.operationId);
    const matches =
      replayed?.action === move.direction && replayed.base_revision === move.input.baseRevision;
    if (!matches) throw new HttpError(409, 'Note history changed');
  }
}

export async function moveNoteHistory(
  db: D1Database,
  ownerId: string,
  noteId: string,
  direction: HistoryDirection,
  input: HistoryInput,
) {
  if (await isHistoryReplay(db, ownerId, noteId, direction, input))
    return loadNoteState(db, ownerId, noteId);
  const state = await loadNoteState(db, ownerId, noteId);
  if (state.note.revision !== input.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: state.note.revision });
  const edit = await loadHistoryEdit(db, ownerId, noteId, direction);
  const undo = direction === 'undo';
  const expectedMarkdown = undo ? edit.after_markdown : edit.before_markdown;
  if (state.note.markdown !== expectedMarkdown) throw new HttpError(409, 'Note history diverged');
  const changes = readSuggestionChanges(edit);
  await assertSuggestionStatuses(db, ownerId, noteId, direction, changes);
  if (undo) await assertNoNewerSuggestions(db, ownerId, noteId, changes);
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
