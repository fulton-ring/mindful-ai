import { deleteAgentMemoryThread } from '../../agent/memory/memory';
import { all } from '../../db/client';
import type { AppDatabase, AppResult } from '../../db/database';
import { nowIso } from '../../http';
import type { ObjectStore } from '../../storage/object-store';
import { deleteAttachmentPrefix } from '../attachments/attachments';

export const EXPLICIT_DELETE_CONVERSATION_SQL = `DELETE FROM conversations
  WHERE id=? AND owner_id=? AND note_id IS NULL`;
/** Archive removes the transcript container while leaving its durable note intact. */
export const EXPLICIT_ARCHIVE_CONVERSATION_SQL = `DELETE FROM conversations
  WHERE id=? AND owner_id=?`;
export const EXPLICIT_DELETE_NOTE_SQL = `DELETE FROM notes
  WHERE owner_id=? AND id=(SELECT note_id FROM conversations WHERE id=? AND owner_id=?)`;
export const conversationDeleteSucceeded = (result: AppResult<unknown> | undefined) =>
  (result?.meta.changes ?? 0) > 0;

export async function purgeExpiredConversations(
  db: AppDatabase,
  files?: ObjectStore,
  purgeExecution?: (ownerId: string, conversationId: string) => Promise<void>,
): Promise<number> {
  const expiredAt = nowIso();
  const expired = await all<{ id: string; owner_id: string }>(
    // Note-backed threads keep an 'expired' shell; skip ones already purged.
    db
      .prepare(
        "SELECT id,owner_id FROM conversations WHERE expires_at<=? AND (status='active' OR note_id IS NULL)",
      )
      .bind(expiredAt),
  );
  if (purgeExecution) for (const row of expired) await purgeExecution(row.owner_id, row.id);
  if (files)
    await Promise.all(
      expired.map(({ id, owner_id }) => deleteAttachmentPrefix(files, owner_id, id)),
    );
  await Promise.all(expired.map(({ id, owner_id }) => deleteAgentMemoryThread(db, owner_id, id)));
  const results = await db.batch([
    db
      .prepare(
        'DELETE FROM interventions WHERE conversation_id IN (SELECT id FROM conversations WHERE expires_at<=? AND note_id IS NOT NULL)',
      )
      .bind(expiredAt),
    db
      .prepare(
        'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE expires_at<=? AND note_id IS NOT NULL)',
      )
      .bind(expiredAt),
    db
      .prepare(
        'DELETE FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE expires_at<=? AND note_id IS NOT NULL)',
      )
      .bind(expiredAt),
    db
      .prepare(
        "UPDATE conversation_branches SET status='expired',head_message_id=NULL WHERE conversation_id IN (SELECT id FROM conversations WHERE expires_at<=? AND note_id IS NOT NULL)",
      )
      .bind(expiredAt),
    db
      .prepare(
        "UPDATE conversations SET status='expired' WHERE expires_at<=? AND note_id IS NOT NULL",
      )
      .bind(expiredAt),
    db.prepare('DELETE FROM conversations WHERE expires_at<=? AND note_id IS NULL').bind(expiredAt),
  ]);
  return results.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
}
