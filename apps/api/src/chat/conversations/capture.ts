import type { Conversation, Note, ProvenanceSpan } from '@walden/contracts';
import { z } from 'zod';
import { first } from '../../db/client';
import { HttpError, newId, nowIso } from '../../http';
import { insertNoteStatement, type NoteRow, toNote } from '../../notes/repository';
import { loadConversation } from './repository';

export const captureSchema = z
  .object({
    text: z.string().min(1).max(200_000),
    verbatim: z.boolean(),
    operationId: z.string().min(1),
  })
  .strict();
type CapturedNoteRow = Omit<NoteRow, 'title'>;
const capturedNote = (row: CapturedNoteRow, title: string): Note => toNote({ ...row, title });

const captureReplay = (
  db: D1Database,
  conversationId: string,
  ownerId: string,
  operationId: string,
) =>
  first<CapturedNoteRow>(
    db
      .prepare(
        'SELECT n.id,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at FROM conversations c JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id JOIN note_edits e ON e.note_id=n.id AND e.owner_id=n.owner_id WHERE c.id=? AND c.owner_id=? AND e.operation_id=?',
      )
      .bind(conversationId, ownerId, operationId),
  );
type CaptureInput = z.infer<typeof captureSchema>;
type CaptureResult = { conversation: Conversation; note: Note; created: boolean };

async function persistCapturedNote(
  db: D1Database,
  ownerId: string,
  conversationId: string,
  conversation: Conversation,
  input: CaptureInput,
) {
  const now = nowIso();
  const noteId = newId();
  const provenance: ProvenanceSpan[] = [
    {
      from: 0,
      to: input.text.length,
      origin: input.verbatim ? 'agent' : 'user',
      verbatim: input.verbatim,
      ...(input.verbatim ? { captureId: input.operationId } : {}),
    },
  ];
  const provenanceJson = JSON.stringify(provenance);
  const results = await db.batch([
    insertNoteStatement(
      db,
      { id: noteId, ownerId, now, title: conversation.title },
      {
        where: `EXISTS (
           SELECT 1 FROM conversations c WHERE c.id=? AND c.owner_id=? AND c.note_id IS NULL
           AND c.status='active' AND c.expires_at>?
           AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id=c.id AND t.owner_id=c.owner_id AND t.status='streaming')
         )`,
        params: [conversationId, ownerId, now],
      },
    ),
    db
      .prepare(
        `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_markdown,before_provenance_json,after_markdown,after_provenance_json,created_at)
         SELECT ?,id,owner_id,?,0,1,'','[]',?,?,? FROM notes WHERE id=? AND owner_id=? AND revision=0`,
      )
      .bind(newId(), input.operationId, input.text, provenanceJson, now, noteId, ownerId),
    db
      .prepare(
        'UPDATE notes SET markdown=?,provenance_json=?,revision=1,updated_at=? WHERE id=? AND owner_id=? AND revision=0 AND EXISTS (SELECT 1 FROM note_edits WHERE note_id=? AND owner_id=? AND operation_id=?)',
      )
      .bind(input.text, provenanceJson, now, noteId, ownerId, noteId, ownerId, input.operationId),
    db
      .prepare(
        `UPDATE conversations SET note_id=? WHERE id=? AND owner_id=? AND note_id IS NULL
         AND status='active' AND expires_at>?
         AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=conversations.id AND owner_id=conversations.owner_id AND status='streaming')
         AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=1)`,
      )
      .bind(noteId, conversationId, ownerId, now, noteId, ownerId),
  ]);
  return { now, noteId, provenance, results };
}

export async function captureConversation(
  db: D1Database,
  ownerId: string,
  conversationId: string,
  input: CaptureInput,
): Promise<CaptureResult> {
  const replay = await captureReplay(db, conversationId, ownerId, input.operationId);
  if (replay) {
    const conversation = await loadConversation(db, ownerId, conversationId);
    return { conversation, note: capturedNote(replay, conversation.title), created: false };
  }
  const conversation = await loadConversation(db, ownerId, conversationId);
  if (conversation.noteId) throw new HttpError(409, 'Conversation already has a note');
  const streaming = await first<{ id: string }>(
    db
      .prepare("SELECT id FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming'")
      .bind(conversationId, ownerId),
  );
  if (streaming) throw new HttpError(409, 'Cannot capture while a turn is streaming');

  const persisted = await persistCapturedNote(db, ownerId, conversationId, conversation, input);
  if (persisted.results.some((result) => result.meta.changes !== 1)) {
    const racedReplay = await captureReplay(db, conversationId, ownerId, input.operationId);
    if (racedReplay) {
      const current = await loadConversation(db, ownerId, conversationId);
      return {
        conversation: current,
        note: capturedNote(racedReplay, current.title),
        created: false,
      };
    }
    throw new HttpError(409, 'Conversation changed during capture');
  }
  conversation.noteId = persisted.noteId;
  return {
    conversation,
    note: {
      id: persisted.noteId,
      title: conversation.title,
      markdown: input.text,
      revision: 1,
      provenance: persisted.provenance,
      createdAt: persisted.now,
      updatedAt: persisted.now,
    },
    created: true,
  };
}
