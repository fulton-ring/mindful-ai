import type { Note, ProvenanceSpan } from '@walden/contracts';
import { first, parseJson } from '../db/client';

export type NoteRow = {
  id: string;
  title: string;
  markdown: string;
  revision: number;
  provenance_json: string;
  created_at: string;
  updated_at: string;
};

export const toNote = (row: NoteRow): Note => ({
  id: row.id,
  title: row.title,
  markdown: row.markdown,
  revision: row.revision,
  provenance: parseJson<ProvenanceSpan[]>(row.provenance_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Title shown for a note that has none of its own and no titled conversation. */
export const DEFAULT_NOTE_TITLE = 'Untitled note';

// Keep owner-scoped note reads on the same title and field projection.
export const NOTE_PROJECTION = `n.id,COALESCE(NULLIF(TRIM(n.title),''),
  (SELECT NULLIF(TRIM(c.title),'') FROM conversations c
   WHERE c.note_id=n.id AND c.owner_id=n.owner_id
   ORDER BY c.last_user_activity_at DESC LIMIT 1),
  '${DEFAULT_NOTE_TITLE}') AS title,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at`;

export const selectNote = (db: D1Database, ownerId: string, id: string) =>
  first<NoteRow>(
    db
      .prepare(`SELECT ${NOTE_PROJECTION} FROM notes n WHERE n.id=? AND n.owner_id=?`)
      .bind(id, ownerId),
  );

type NewNote = { id: string; ownerId: string; title: string; now: string; markdown?: string };

/**
 * Every note starts at revision 0 with no provenance. `guard` is an optional SQL
 * condition (with its bound params) that must hold for the row to be inserted,
 * so callers can make creation conditional inside a batch.
 */
export const insertNoteStatement = (
  db: D1Database,
  note: NewNote,
  guard?: { where: string; params: unknown[] },
) =>
  db
    .prepare(
      `INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title)
       SELECT ?,?,?,0,'[]',?,?,?${guard ? ` WHERE ${guard.where}` : ''}`,
    )
    .bind(
      note.id,
      note.ownerId,
      note.markdown ?? '',
      note.now,
      note.now,
      note.title.trim() || DEFAULT_NOTE_TITLE,
      ...(guard?.params ?? []),
    );
