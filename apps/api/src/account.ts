import { createClerkClient } from '@clerk/backend';
import { Hono } from 'hono';
import { all } from './db/client';
import { HttpError } from './http';
import type { Bindings, Variables } from './types';

export const accountRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
accountRoutes.get('/me', async (c) => {
  const usage = await c.env.DB.prepare('SELECT plan FROM usage_periods WHERE owner_id=?')
    .bind(c.get('userId'))
    .first<{ plan: string }>();
  return c.json({ id: c.get('userId'), plan: usage?.plan ?? 'free' });
});
accountRoutes.get('/account/export', async (c) => {
  const ownerId = c.get('userId');
  const now = new Date().toISOString();
  const [notes, personas, conversations, branches, messages, highlights] = await Promise.all([
    all<Record<string, unknown>>(
      c.env.DB.prepare(
        `SELECT n.id,COALESCE(NULLIF(TRIM(n.title),''),
           (SELECT NULLIF(TRIM(c.title),'') FROM conversations c
             WHERE c.note_id=n.id AND c.owner_id=n.owner_id
             ORDER BY c.last_user_activity_at DESC LIMIT 1),
           'Untitled note') AS title,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at FROM notes n WHERE n.owner_id=?`,
      ).bind(ownerId),
    ),
    all<Record<string, unknown>>(
      c.env.DB.prepare(
        'SELECT id,name,prompt,brevity,challenge,tone,revision,created_at,updated_at FROM personas WHERE owner_id=?',
      ).bind(ownerId),
    ),
    all<Record<string, unknown>>(
      c.env.DB.prepare(
        "SELECT id,title,note_id,learning_checks_enabled,last_user_activity_at,expires_at,status,created_at FROM conversations WHERE owner_id=? AND expires_at>? AND status='active'",
      ).bind(ownerId, now),
    ),
    all<Record<string, unknown>>(
      c.env.DB.prepare(
        "SELECT id,conversation_id,head_message_id,forked_from_message_id,is_default,status,last_user_activity_at,expires_at,created_at FROM conversation_branches WHERE owner_id=? AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=? AND expires_at>? AND status='active') ORDER BY conversation_id,created_at",
      ).bind(ownerId, ownerId, now),
    ),
    all<Record<string, unknown>>(
      c.env.DB.prepare(
        "SELECT id,conversation_id,role,content,reasoning,activity_json,incomplete,sequence,parent_message_id,origin_branch_id,created_at FROM messages WHERE owner_id=? AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=? AND expires_at>? AND status='active') ORDER BY conversation_id,sequence",
      ).bind(ownerId, ownerId, now),
    ),
    all<Record<string, unknown>>(
      c.env.DB.prepare(
        `SELECT h.message_id,h.origin,h.start,h.end,h.quote,h.color,h.kind,h.updated_at
         FROM message_highlights h
         JOIN messages m ON m.id=h.message_id AND m.owner_id=h.owner_id
         JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
         WHERE h.owner_id=? AND c.status='active' AND c.expires_at>?
         ORDER BY h.message_id,h.origin,h.updated_at,h.rowid`,
      ).bind(ownerId, now),
    ),
  ]);
  return c.json(
    { exportedAt: now, notes, personas, conversations, branches, messages, highlights },
    200,
    { 'content-disposition': 'attachment; filename="walden-export.json"' },
  );
});
accountRoutes.delete('/account', async (c) => {
  const ownerId = c.get('userId');
  if (c.env.CLERK_SECRET_KEY) {
    try {
      await createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY }).users.deleteUser(
        c.get('authSubject'),
      );
    } catch {
      await c.env.DB.prepare('UPDATE users SET deletion_pending=1,updated_at=? WHERE id=?')
        .bind(new Date().toISOString(), ownerId)
        .run();
      throw new HttpError(503, 'Identity deletion failed; deletion is pending and can be retried');
    }
  }
  await c.env.DB.prepare('DELETE FROM users WHERE id=?').bind(ownerId).run();
  return c.body(null, 204);
});
