import type { Annotation } from '@walden/contracts';

/**
 * Agent marks and user highlights share one table, separated by `origin`.
 * Regenerating model highlights therefore replaces exactly the agent rows and
 * leaves everything the user owns - including null-colour removals - intact.
 */
export function agentHighlightStatements(
  db: D1Database,
  input: {
    messageId: string;
    ownerId: string;
    content: string;
    annotations: readonly Annotation[];
    updatedAt: string;
  },
): D1PreparedStatement[] {
  const rows = input.annotations.flatMap((annotation) => {
    const start = input.content.indexOf(annotation.quote);
    // A quote that is absent or ambiguous has no single anchor to store.
    if (start < 0 || input.content.indexOf(annotation.quote, start + 1) >= 0) return [];
    return [{ start, end: start + annotation.quote.length, annotation }];
  });
  return [
    db
      .prepare(
        "DELETE FROM message_highlights WHERE message_id=? AND owner_id=? AND origin='agent'",
      )
      .bind(input.messageId, input.ownerId),
    ...rows.map(({ start, end, annotation }) =>
      db
        .prepare(
          `INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,color,kind,updated_at)
           VALUES (?,?,'agent',?,?,?,NULL,?,?)
           ON CONFLICT(message_id,origin,start,end) DO UPDATE SET
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
        ),
    ),
  ];
}
