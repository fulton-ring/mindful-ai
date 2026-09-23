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

// Keep owner-scoped note reads on the same title and field projection.
export const NOTE_PROJECTION = `n.id,COALESCE(NULLIF(TRIM(n.title),''),
  (SELECT NULLIF(TRIM(c.title),'') FROM conversations c
   WHERE c.note_id=n.id AND c.owner_id=n.owner_id
   ORDER BY c.last_user_activity_at DESC LIMIT 1),
  'Untitled note') AS title,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at`;

export const selectNote = (db: D1Database, ownerId: string, id: string) =>
  first<NoteRow>(
    db
      .prepare(`SELECT ${NOTE_PROJECTION} FROM notes n WHERE n.id=? AND n.owner_id=?`)
      .bind(id, ownerId),
  );
