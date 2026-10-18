import type { Annotation } from '@walden/contracts';
import type { AppDatabase, AppStatement } from '../../db/database';

/**
 * Agent marks and user highlights share one table, separated by `origin`.
 * Regenerating model highlights therefore replaces exactly the agent rows and
 * leaves everything the user owns - including null-colour removals - intact.
 */
export function agentHighlightStatements(
  db: AppDatabase,
  input: {
    messageId: string;
    ownerId: string;
    content: string;
    annotations: readonly Annotation[];
    updatedAt: string;
    /** Applies only if the turn committed at this time; used inside the completion batch. */
    completedAt?: string;
    executionGeneration?: number;
  },
): AppStatement[] {
  const rows = input.annotations.flatMap((annotation) => {
    const start = input.content.indexOf(annotation.quote);
    // A quote that is absent or ambiguous has no single anchor to store.
    if (start < 0 || input.content.indexOf(annotation.quote, start + 1) >= 0) return [];
    return [{ start, end: start + annotation.quote.length, annotation }];
  });
  const committed =
    input.completedAt === undefined
      ? undefined
      : {
          sql: `EXISTS(SELECT 1 FROM turns WHERE id=? AND owner_id=? AND status='completed' AND completed_at=?${input.executionGeneration === undefined ? '' : ' AND execution_generation=?'})`,
          values: [
            input.messageId,
            input.ownerId,
            input.completedAt,
            ...(input.executionGeneration === undefined ? [] : [input.executionGeneration]),
          ],
        };
  return [
    db
      .prepare(
        `DELETE FROM message_highlights WHERE message_id=? AND owner_id=? AND origin='agent'${committed ? ` AND ${committed.sql}` : ''}`,
      )
      .bind(input.messageId, input.ownerId, ...(committed?.values ?? [])),
    ...rows.map(({ start, end, annotation }) =>
      db
        .prepare(
          `INSERT INTO message_highlights (message_id,owner_id,origin,start,"end",quote,color,kind,updated_at)
           ${committed ? `SELECT ?,?,'agent',?,?,?,NULL,?,? WHERE ${committed.sql}` : "VALUES (?,?,'agent',?,?,?,NULL,?,?)"}
           ON CONFLICT(message_id,origin,start,"end") DO UPDATE SET
             quote=excluded.quote,kind=excluded.kind,updated_at=excluded.updated_at`,
        )
        .bind(
          input.messageId,
          input.ownerId,
          start,
          end,
          annotation.quote,
          annotation.kind,
          input.updatedAt,
          ...(committed?.values ?? []),
        ),
    ),
  ];
}
