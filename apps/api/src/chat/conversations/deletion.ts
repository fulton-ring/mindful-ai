import { deleteAgentMemoryThread } from '../../agent/memory/memory';
import { all } from '../../db/client';
import type { AppDatabase, AppResult } from '../../db/database';
import { newId, nowIso } from '../../http';
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

/** A failed external cleanup is retried after 15 minutes; ordinary overlapping jobs cannot reclaim it. */
export const PURGE_RETRY_MS = 15 * 60_000;
export async function purgeExpiredConversations(
  db: AppDatabase,
  files?: ObjectStore,
  purgeExecution?: (ownerId: string, conversationId: string) => Promise<void>,
): Promise<number> {
  const claimedAt = nowIso();
  const token = newId();
  const staleAt = new Date(Date.now() - PURGE_RETRY_MS).toISOString();
  // Claim before touching external state. Policy synchronization and renewal skip this terminal state.
  const claimed = await all<{ id: string; owner_id: string; note_id: string | null }>(
    db
      .prepare(`UPDATE conversations SET status='purging',purge_started_at=?,purge_token=?
      WHERE (status='purging' AND (purge_started_at IS NULL OR purge_started_at<=?))
        OR (status<>'purging' AND retention_disabled=0 AND expires_at<=? AND (status='active' OR note_id IS NULL))
      RETURNING id,owner_id,note_id`)
      .bind(claimedAt, token, staleAt, claimedAt),
  );
  let changes = 0;
  for (const row of claimed) {
    if (purgeExecution) await purgeExecution(row.owner_id, row.id);
    if (files) await deleteAttachmentPrefix(files, row.owner_id, row.id);
    await deleteAgentMemoryThread(db, row.owner_id, row.id);
    const guard =
      "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='purging' AND purge_token=?";
    const bind = [row.id, row.owner_id, token];
    const statements =
      row.note_id === null
        ? [db.prepare(`DELETE FROM conversations WHERE id IN (${guard})`).bind(...bind)]
        : [
            ...['interventions', 'messages', 'turns'].map((table) =>
              db.prepare(`DELETE FROM ${table} WHERE conversation_id IN (${guard})`).bind(...bind),
            ),
            db
              .prepare(
                `UPDATE conversation_branches SET status='expired',head_message_id=NULL WHERE conversation_id IN (${guard})`,
              )
              .bind(...bind),
            db
              .prepare(
                `UPDATE conversations SET status='expired',purge_started_at=NULL,purge_token=NULL WHERE id IN (${guard})`,
              )
              .bind(...bind),
          ];
    const results = await db.batch(statements);
    changes += results.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
  }
  return changes;
}
