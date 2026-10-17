import { type ProvenanceSpan, saveNoteSchema } from '@walden/contracts';
import type { z } from 'zod';
import { first } from '../db/client';
import type { AppDatabase, AppStatement } from '../db/database';
import { HttpError, newId, nowIso } from '../http';
import { dismissChange, hasNoteEdit } from './operations';
import { type NoteRow, selectNote, toNote } from './repository';

type SaveNoteInput = z.infer<typeof saveNoteSchema>;

export function assertValidProvenance(markdown: string, provenance: ProvenanceSpan[]): void {
  let previousEnd = 0;
  for (const span of [...provenance].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (span.from > span.to || span.to > markdown.length)
      throw new HttpError(400, 'Invalid provenance range');
    if (span.from < previousEnd) throw new HttpError(400, 'Provenance spans overlap');
    if (span.origin === 'user' && span.verbatim)
      throw new HttpError(400, 'User provenance cannot be verbatim agent text');
    previousEnd = span.to;
  }
}

const loadDismissedSuggestionIds = async (
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  input: SaveNoteInput,
) => {
  const ids = [...new Set(input.dismissSuggestionIds ?? [])];
  const suggestions = await Promise.all(
    ids.map((id) =>
      first<{ status: string }>(
        db
          .prepare('SELECT status FROM note_suggestions WHERE id=? AND note_id=? AND owner_id=?')
          .bind(id, noteId, ownerId),
      ),
    ),
  );
  if (suggestions.some((suggestion) => suggestion?.status !== 'pending'))
    throw new HttpError(409, 'Suggestion is no longer pending');
  return ids;
};

const buildSaveStatements = (
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  current: NoteRow,
  input: SaveNoteInput,
  dismissedIds: string[],
  now: string,
) => {
  const provenanceJson = JSON.stringify(input.provenance);
  const changes = dismissedIds.map(dismissChange);
  const pendingIdsCondition = dismissedIds.length
    ? ` AND (SELECT COUNT(*) FROM note_suggestions WHERE note_id=notes.id AND owner_id=notes.owner_id AND status='pending' AND id IN (${dismissedIds.map(() => '?').join(',')}))=?`
    : '';
  const edit = db.prepare(
    `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_markdown,before_provenance_json,after_markdown,after_provenance_json,created_at,suggestion_changes_json) SELECT ?,id,owner_id,?,revision,revision+1,markdown,provenance_json,?,?,?,? FROM notes WHERE id=? AND owner_id=? AND revision=?${pendingIdsCondition}`,
  );
  const editValues = [
    newId(),
    input.operationId,
    input.markdown,
    provenanceJson,
    now,
    changes.length ? JSON.stringify(changes) : null,
    noteId,
    ownerId,
    current.revision,
    ...dismissedIds,
    ...(dismissedIds.length ? [dismissedIds.length] : []),
  ];
  return [
    edit.bind(...editValues),
    db
      .prepare(
        'UPDATE notes SET markdown=?,provenance_json=?,revision=?,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS (SELECT 1 FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?)',
      )
      .bind(
        input.markdown,
        provenanceJson,
        current.revision + 1,
        now,
        noteId,
        ownerId,
        current.revision,
        ownerId,
        noteId,
        input.operationId,
      ),
    ...dismissedIds.map((id) =>
      db
        .prepare(
          "UPDATE note_suggestions SET status='dismissed',updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status='pending' AND EXISTS (SELECT 1 FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?)",
        )
        .bind(now, id, noteId, ownerId, ownerId, noteId, input.operationId),
    ),
    db
      .prepare(
        'UPDATE note_edits SET discarded=1 WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 AND operation_id<>? AND EXISTS (SELECT 1 FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?)',
      )
      .bind(noteId, ownerId, input.operationId, ownerId, noteId, input.operationId),
  ];
};

/** A save that already landed (a retry, or a concurrent duplicate) answers with the current note. */
async function replaySavedNote(db: AppDatabase, ownerId: string, noteId: string) {
  const replay = await selectNote(db, ownerId, noteId);
  if (!replay) throw new HttpError(404, 'Note not found');
  return toNote(replay);
}

async function runSaveBatch(
  db: AppDatabase,
  statements: AppStatement[],
  key: { ownerId: string; noteId: string; operationId: string },
) {
  try {
    return await db.batch(statements);
  } catch {
    if (await hasNoteEdit(db, key)) return null;
    throw new HttpError(409, 'Note revision conflict');
  }
}

async function saveNoteInTransaction(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  input: SaveNoteInput,
) {
  const key = { ownerId, noteId, operationId: input.operationId };
  if (await hasNoteEdit(db, key)) return replaySavedNote(db, ownerId, noteId);
  const current = await selectNote(db, ownerId, noteId);
  if (!current) throw new HttpError(404, 'Note not found');
  if (current.revision !== input.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: current.revision });
  const dismissedIds = await loadDismissedSuggestionIds(db, ownerId, noteId, input);
  assertValidProvenance(input.markdown, input.provenance);
  const now = nowIso();
  const results = await runSaveBatch(
    db,
    buildSaveStatements(db, ownerId, noteId, current, input, dismissedIds, now),
    key,
  );
  if (!results) return replaySavedNote(db, ownerId, noteId);
  const failed =
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results.slice(2, 2 + dismissedIds.length).some((result) => result.meta.changes !== 1);
  if (failed) {
    const latest = await selectNote(db, ownerId, noteId);
    throw new HttpError(
      409,
      'Note revision conflict',
      latest ? { currentRevision: latest.revision } : undefined,
    );
  }
  return toNote({
    ...current,
    markdown: input.markdown,
    provenance_json: JSON.stringify(input.provenance),
    revision: current.revision + 1,
    updated_at: now,
  });
}

export async function saveNote(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
  input: SaveNoteInput,
) {
  return db.transaction
    ? db.transaction(
        (connection) => saveNoteInTransaction(connection, ownerId, noteId, input),
        [`owner:${ownerId}`],
      )
    : saveNoteInTransaction(db, ownerId, noteId, input);
}
