import { createClerkClient } from '@clerk/backend';
import { Hono } from 'hono';
import { PRIVACY_VERSION } from './content-telemetry';
import { all } from './db/client';
import { HttpError, jsonBody } from './http';
import type { Bindings, Variables } from './types';

export const accountRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
accountRoutes.get('/me', async (c) => {
  const usage = await c.env.DB.prepare('SELECT plan FROM usage_periods WHERE owner_id=?')
    .bind(c.get('userId'))
    .first<{ plan: string }>();
  return c.json({ id: c.get('userId'), plan: usage?.plan ?? 'free' });
});
accountRoutes.get('/account/privacy', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT enabled,disclosure_version,acknowledged_at FROM account_privacy WHERE owner_id=?',
  )
    .bind(c.get('userId'))
    .first<{ enabled: number; disclosure_version: string; acknowledged_at: string }>();
  return c.json({
    enabled: row ? !!row.enabled : true,
    acknowledged: row?.disclosure_version === PRIVACY_VERSION,
    version: PRIVACY_VERSION,
  });
});
accountRoutes.put('/account/privacy', async (c) => {
  const body = await jsonBody<{ enabled?: unknown; version?: unknown }>(c);
  if (!body || typeof body.enabled !== 'boolean' || body.version !== PRIVACY_VERSION)
    throw new HttpError(400, 'Invalid privacy preference or disclosure version');
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO account_privacy (owner_id,enabled,disclosure_version,acknowledged_at,updated_at,revision) VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,disclosure_version=excluded.disclosure_version,updated_at=excluded.updated_at,revision=excluded.revision`,
  )
    .bind(c.get('userId'), body.enabled ? 1 : 0, PRIVACY_VERSION, now, now, crypto.randomUUID())
    .run();
  return c.json({ enabled: body.enabled, acknowledged: true, version: PRIVACY_VERSION });
});
accountRoutes.get('/account/export', async (c) => {
  const ownerId = c.get('userId');
  const now = new Date().toISOString();
  const [notes, personas, conversations, branches, messages, highlights, privacy] =
    await Promise.all([
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
          'SELECT id,name,prompt,brevity,challenge,tone,revision,icon,created_at,updated_at FROM personas WHERE owner_id=?',
        ).bind(ownerId),
      ),
      all<Record<string, unknown>>(
        c.env.DB.prepare(
          "SELECT id,title,note_id,learning_checks_enabled,web_search_enabled,last_user_activity_at,expires_at,status,created_at FROM conversations WHERE owner_id=? AND expires_at>? AND status='active'",
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
      c.env.DB.prepare(
        'SELECT enabled,disclosure_version,acknowledged_at,updated_at FROM account_privacy WHERE owner_id=?',
      )
        .bind(ownerId)
        .first(),
    ]);
  return c.json(
    {
      exportedAt: now,
      notes,
      personas,
      conversations,
      branches,
      messages,
      highlights,
      privacy: privacy ?? null,
    },
    200,
    { 'content-disposition': 'attachment; filename="walden-export.json"' },
  );
});
accountRoutes.delete('/account', async (c) => {
  const ownerId = c.get('userId');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET deletion_pending=1 WHERE id=?').bind(ownerId),
    c.env.DB.prepare(
      'INSERT INTO telemetry_deletions (distinct_id,requested_at) VALUES (?,?) ON CONFLICT(distinct_id) DO NOTHING',
    ).bind(c.get('authSubject'), new Date().toISOString()),
  ]);
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
