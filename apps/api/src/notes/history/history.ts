import type { Note, NoteState } from '@walden/contracts';
import { applyProposal } from '@walden/domain';
import { all, first, parseJson } from '../../db/client';
import { HttpError } from '../../http';
import {
  SELECT_SUGGESTION,
  type SuggestionRow,
  toNoteSuggestion,
} from '../suggestions/suggestions';

type NoteStateRow = {
  id: string;
  title: string;
  markdown: string;
  revision: number;
  provenance_json: string;
  created_at: string;
  updated_at: string;
};

export async function loadNoteState(
  db: D1Database,
  ownerId: string,
  noteId: string,
): Promise<NoteState> {
  const row = await first<NoteStateRow>(
    db
      .prepare(
        // The note owns its name. The conversation subquery is only a fallback
        // for notes created before the title column existed.
        `SELECT n.id,COALESCE(NULLIF(TRIM(n.title),''),
           (SELECT NULLIF(TRIM(c.title),'') FROM conversations c
             WHERE c.note_id=n.id AND c.owner_id=n.owner_id
             ORDER BY c.last_user_activity_at DESC LIMIT 1),
           'Untitled note') AS title,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at
       FROM notes n WHERE n.id=? AND n.owner_id=?`,
      )
      .bind(noteId, ownerId),
  );
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
  const note: Note = {
    id: row.id,
    title: row.title,
    markdown: row.markdown,
    revision: row.revision,
    provenance: parseJson(row.provenance_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
