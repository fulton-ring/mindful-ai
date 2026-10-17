import { Hono } from 'hono';
import { z } from 'zod';
import { deleteAccountIdentity } from '../auth/delete-identity';
import { deleteAttachmentPrefix } from '../chat/attachments/attachments';
import { all, first } from '../db/client';
import { purgeOwnerExecution } from '../execution/privacy';
import { newId, nowIso, parseBody } from '../http';
import { NOTE_PROJECTION } from '../notes/repository';
import { researchOwnerScope } from '../services/research/research';
import type { Bindings, Variables } from '../types';
import { PRIVACY_VERSION } from './content-telemetry';

const privacySchema = z.object({ enabled: z.boolean(), version: z.literal(PRIVACY_VERSION) });
/** Conversations whose transcripts still exist, the scope of everything exported below. */
const LIVE_CONVERSATIONS =
  "SELECT id FROM conversations WHERE owner_id=? AND expires_at>? AND status='active'";

export const accountRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
accountRoutes.get('/account/privacy', async (c) => {
  const row = await first<{ enabled: number; disclosure_version: string }>(
    c.env.DB.prepare(
      'SELECT enabled,disclosure_version FROM account_privacy WHERE owner_id=?',
    ).bind(c.get('userId')),
  );
  return c.json({
    enabled: row ? !!row.enabled : true,
    acknowledged: row?.disclosure_version === PRIVACY_VERSION,
    version: PRIVACY_VERSION,
  });
});
accountRoutes.put('/account/privacy', async (c) => {
  const body = await parseBody(
    c,
    privacySchema,
    'Invalid privacy preference or disclosure version',
  );
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO account_privacy (owner_id,enabled,disclosure_version,acknowledged_at,updated_at,revision) VALUES (?,?,?,?,?,?)
     ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,disclosure_version=excluded.disclosure_version,
       acknowledged_at=excluded.acknowledged_at,updated_at=excluded.updated_at,revision=excluded.revision`,
  )
    .bind(c.get('userId'), body.enabled ? 1 : 0, PRIVACY_VERSION, now, now, newId())
    .run();
  return c.json({ enabled: body.enabled, acknowledged: true, version: PRIVACY_VERSION });
});
accountRoutes.get('/account/export', async (c) => {
  const ownerId = c.get('userId');
  const now = nowIso();
  const rows = (sql: string, ...values: unknown[]) =>
    all<Record<string, unknown>>(c.env.DB.prepare(sql).bind(...values));
  const [notes, personas, conversations, branches, messages, highlights, privacy] =
    await Promise.all([
      rows(`SELECT ${NOTE_PROJECTION} FROM notes n WHERE n.owner_id=?`, ownerId),
      rows(
        'SELECT id,name,prompt,model,brevity,challenge,tone,icon,replaces_persona_id,created_at,updated_at FROM personas WHERE owner_id=?',
        ownerId,
      ),
      rows(
        "SELECT id,title,note_id,learning_checks_enabled,web_search_enabled,last_user_activity_at,expires_at,status,created_at FROM conversations WHERE owner_id=? AND expires_at>? AND status='active'",
        ownerId,
        now,
      ),
      rows(
        `SELECT id,conversation_id,head_message_id,forked_from_message_id,is_default,status,created_at FROM conversation_branches
         WHERE owner_id=? AND conversation_id IN (${LIVE_CONVERSATIONS}) ORDER BY conversation_id,created_at`,
        ownerId,
        ownerId,
        now,
      ),
      rows(
        `SELECT id,conversation_id,role,parent_message_id,origin_branch_id,created_at,ui_message FROM messages
         WHERE owner_id=? AND conversation_id IN (${LIVE_CONVERSATIONS}) ORDER BY conversation_id,created_at,id`,
        ownerId,
        ownerId,
        now,
      ),
      rows(
        `SELECT h.message_id,h.origin,h.start,h.end,h.quote,h.color,h.kind,h.updated_at
         FROM message_highlights h
         JOIN messages m ON m.id=h.message_id AND m.owner_id=h.owner_id
         JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
         WHERE h.owner_id=? AND c.status='active' AND c.expires_at>?
         ORDER BY h.message_id,h.origin,h.updated_at,h.start,h."end"`,
        ownerId,
        now,
      ),
      first<Record<string, unknown>>(
        c.env.DB.prepare(
          'SELECT enabled,disclosure_version,acknowledged_at,updated_at FROM account_privacy WHERE owner_id=?',
        ).bind(ownerId),
      ),
    ]);
  return c.json(
    {
      exportedAt: now,
      notes,
      personas,
      conversations,
      branches,
      messages: messages.map(({ ui_message, ...message }) => ({
        ...message,
        message: JSON.parse(String(ui_message)) as unknown,
      })),
      highlights,
      privacy,
    },
    200,
    { 'content-disposition': 'attachment; filename="walden-export.json"' },
  );
});
accountRoutes.delete('/account', async (c) => {
  const ownerId = c.get('userId');
  if (c.env.FILES) await deleteAttachmentPrefix(c.env.FILES, ownerId);
  // Mark deletion first so a failed identity deletion stays pending and retryable.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET deletion_pending=1,updated_at=? WHERE id=?').bind(
      nowIso(),
      ownerId,
    ),
    c.env.DB.prepare(
      'INSERT INTO telemetry_deletions (distinct_id,requested_at) VALUES (?,?) ON CONFLICT(distinct_id) DO NOTHING',
    ).bind(c.get('authSubject'), nowIso()),
  ]);
  await c.env.SAVED_SOURCES?.deleteOwner(await researchOwnerScope(ownerId));
  await purgeOwnerExecution(c.env, ownerId);
  await deleteAccountIdentity(c.env, ownerId, c.get('authSubject'));
  await c.env.DB.prepare('DELETE FROM users WHERE id=?').bind(ownerId).run();
  return c.body(null, 204);
});
