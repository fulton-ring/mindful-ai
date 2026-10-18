import { all } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import { nowIso } from '../../http';
import { getAccountPolicy } from '../../policy';
import type { Bindings } from '../../types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 7;

/** Keep the existing NOT NULL timestamp; the explicit flag makes expiry optional. */
export function retentionExpiry(
  idleDays: number | null = DEFAULT_RETENTION_DAYS,
  activityAt = nowIso(),
) {
  const expiresAt =
    idleDays === null ? null : new Date(Date.parse(activityAt) + idleDays * DAY_MS).toISOString();
  return {
    expiresAt,
    storedExpiresAt: expiresAt ?? activityAt,
    retentionDisabled: idleDays === null ? 1 : 0,
  };
}

/** Rebase only unpurged active transcripts; a plan change never revives an expired shell. */
export async function syncOwnerRetention(
  db: AppDatabase,
  ownerId: string,
  idleDays: number | null,
): Promise<void> {
  const rows = await all<{
    id: string;
    last_user_activity_at: string;
    expires_at: string;
    retention_disabled: number;
  }>(
    db
      .prepare(
        "SELECT id,last_user_activity_at,expires_at,retention_disabled FROM conversations WHERE owner_id=? AND status='active'",
      )
      .bind(ownerId),
  );
  const statements = rows.flatMap((row) => {
    // Historical malformed activity timestamps cannot safely be used to invent a new deadline.
    const expiry = Number.isFinite(Date.parse(row.last_user_activity_at))
      ? retentionExpiry(idleDays, row.last_user_activity_at)
      : { storedExpiresAt: row.expires_at, retentionDisabled: idleDays === null ? 1 : 0 };
    if (
      row.expires_at === expiry.storedExpiresAt &&
      row.retention_disabled === expiry.retentionDisabled
    )
      return [];
    return [
      db
        .prepare(
          "UPDATE conversations SET expires_at=?,retention_disabled=? WHERE id=? AND owner_id=? AND status='active' AND last_user_activity_at=?",
        )
        .bind(
          expiry.storedExpiresAt,
          expiry.retentionDisabled,
          row.id,
          ownerId,
          row.last_user_activity_at,
        ),
    ];
  });
  if (statements.length) await db.batch(statements);
}

export async function syncAccountRetention(env: Bindings, ownerId: string): Promise<void> {
  const { policy } = await getAccountPolicy(env, ownerId);
  await syncOwnerRetention(env.DB, ownerId, policy.retention.idleDays);
}

/** Scheduled purge must resolve current entitlements before examining old stored deadlines. */
export async function syncRetentionPolicies(env: Bindings): Promise<void> {
  const owners = await all<{ owner_id: string }>(
    env.DB.prepare("SELECT DISTINCT owner_id FROM conversations WHERE status='active'"),
  );
  for (const { owner_id } of owners) {
    await syncAccountRetention(env, owner_id);
  }
}
