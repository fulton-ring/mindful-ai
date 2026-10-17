import type { Note, NoteState } from '@walden/contracts';
import { applyProposal } from '@walden/domain';
import { all, first } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import { HttpError } from '../../http';
import { selectNote, toNote } from '../repository';
import { SELECT_SUGGESTION, type SuggestionRow, toNoteSuggestion } from '../suggestions/queries';

export async function loadNoteState(
  db: AppDatabase,
  ownerId: string,
  noteId: string,
): Promise<NoteState> {
  const row = await selectNote(db, ownerId, noteId);
  if (!row) throw new HttpError(404, 'Note not found');
  const [suggestions, undo, redo] = await Promise.all([
    all<SuggestionRow>(
      db
        .prepare(`${SELECT_SUGGESTION} WHERE note_id=? AND owner_id=? ORDER BY created_at DESC`)
        .bind(noteId, ownerId),
    ),
    first<{ id: string }>(
      db
        .prepare(
          'SELECT id FROM note_edits WHERE note_id=? AND owner_id=? AND undone=0 AND discarded=0 ORDER BY result_revision DESC LIMIT 1',
        )
        .bind(noteId, ownerId),
    ),
    first<{ id: string }>(
      db
        .prepare(
          'SELECT id FROM note_edits WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 ORDER BY result_revision ASC LIMIT 1',
        )
        .bind(noteId, ownerId),
    ),
  ]);
  const note = toNote(row);
  return {
    note,
    suggestions: suggestions.map((suggestion) => {
      const value = toNoteSuggestion(suggestion);
      if (value.status !== 'pending') return value;
      try {
        applyProposal(note, { ...value, baseRevision: note.revision });
        return { ...value, baseRevision: note.revision };
      } catch {
        return { ...value, status: 'invalidated' as const };
      }
    }),
    canUndo: Boolean(undo),
    canRedo: Boolean(redo),
  };
}

export function applySuggestionPatch(
  note: Note,
  suggestion: {
    id: string;
    oldText: string;
    newText: string;
    reason: string;
  },
  queue?: readonly { id: string; text: string; accepted?: boolean }[],
) {
  try {
    return applyProposal(
      note,
      { ...suggestion, noteId: note.id, baseRevision: note.revision, status: 'pending' },
      queue,
    );
  } catch {
    throw new HttpError(409, 'Suggestion is stale');
  }
}
