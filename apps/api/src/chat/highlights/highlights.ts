import { messageHighlightSchema, uiMessageText } from '@walden/contracts';
import { Hono } from 'hono';
import { first } from '../../db/client';
import { HttpError, jsonBody, nowIso } from '../../http';
import type { Bindings, Variables } from '../../types';
import { notInterruptedSql, parseStoredMessage } from '../messages';

export const highlightRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

highlightRoutes.put('/messages/:messageId/highlights', async (c) => {
  const parsed = messageHighlightSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid highlight');
  const ownerId = c.get('userId');
  const messageId = c.req.param('messageId');
  const now = nowIso();
  const message = await first<{ ui_message: string }>(
    c.env.DB.prepare(
      `SELECT m.ui_message FROM messages m
         JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
         JOIN conversation_branches b ON b.id=m.origin_branch_id AND b.conversation_id=c.id AND b.owner_id=c.owner_id
         WHERE m.id=? AND m.owner_id=? AND m.role='assistant' AND ${notInterruptedSql('m')}
         AND c.status='active' AND c.expires_at>? AND b.status='active'`,
    ).bind(messageId, ownerId, now),
  );
  if (!message) throw new HttpError(404, 'Completed response not found');
  // Offsets index the message's visible text: its text parts, joined.
  const text = uiMessageText(parseStoredMessage(message.ui_message));
  if (
    parsed.data.end > text.length ||
    text.slice(parsed.data.start, parsed.data.end) !== parsed.data.quote
  )
    throw new HttpError(400, 'Highlight range does not match the response');
  const saved = await c.env.DB.prepare(
    `INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,color,updated_at)
       SELECT m.id,m.owner_id,'user',?,?,?,?,? FROM messages m
       JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
       JOIN conversation_branches b ON b.id=m.origin_branch_id AND b.conversation_id=c.id AND b.owner_id=c.owner_id
       WHERE m.id=? AND m.owner_id=? AND m.role='assistant' AND ${notInterruptedSql('m')} AND m.ui_message=?
       AND c.status='active' AND c.expires_at>? AND b.status='active'
       ON CONFLICT(message_id,origin,start,end) DO UPDATE SET
         quote=excluded.quote,color=excluded.color,updated_at=excluded.updated_at
       WHERE message_highlights.owner_id=excluded.owner_id`,
  )
    .bind(
      parsed.data.start,
      parsed.data.end,
      parsed.data.quote,
      parsed.data.color,
      now,
      messageId,
      ownerId,
      message.ui_message,
      now,
    )
    .run();
  if (saved.meta.changes !== 1) throw new HttpError(409, 'Response changed');
  return c.json(parsed.data);
});
