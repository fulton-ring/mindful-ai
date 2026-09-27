import { first } from '../db/client';
import { HttpError } from '../http';

/** A suggestion status change recorded on a note edit so undo/redo can reverse it. */
export type SuggestionChange = { id: string; beforeStatus: string; afterStatus: string };

export const dismissChange = (id: string): SuggestionChange => ({
  id,
  beforeStatus: 'pending',
  afterStatus: 'dismissed',
});

type OperationKey = { ownerId: string; noteId: string; operationId: string };
type OperationRequest = { action: string; base_revision: number };
type ExpectedOperation = { action: string; baseRevision: number };

/** Whether a note edit was already recorded under this client operation ID. */
export const hasNoteEdit = async (db: D1Database, key: OperationKey) =>
  Boolean(
    await first<{ id: string }>(
      db
        .prepare('SELECT id FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?')
        .bind(key.ownerId, key.noteId, key.operationId),
    ),
  );

/** The recorded undo/redo/decision request for this operation ID, if it already ran. */
export const loadOperationRequest = (db: D1Database, key: OperationKey) =>
  first<OperationRequest>(
    db
      .prepare(
        'SELECT action,base_revision FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=?',
      )
      .bind(key.ownerId, key.noteId, key.operationId),
  );

const matches = (request: OperationRequest | null, expected: ExpectedOperation) =>
  request?.action === expected.action && request.base_revision === expected.baseRevision;

/** A replayed operation ID must describe the same request it was first used for. */
export function assertReplayMatches(request: OperationRequest, expected: ExpectedOperation) {
  if (!matches(request, expected)) throw new HttpError(409, 'Operation ID was already used');
}

/**
 * Run a guarded batch whose first `checked` statements must each change one row.
 * A thrown batch is treated as success only when a concurrent retry of the same
 * operation already recorded it; everything else is reported as `conflict`.
 */
export async function runIdempotentBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  options: {
    key: OperationKey;
    expected: ExpectedOperation;
    checked: number;
    conflict: string;
  },
) {
  try {
    const results = await db.batch(statements);
    if (results.slice(0, options.checked).some((result) => result.meta.changes !== 1))
      throw new HttpError(409, options.conflict);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (!matches(await loadOperationRequest(db, options.key), options.expected))
      throw new HttpError(409, options.conflict);
  }
}
