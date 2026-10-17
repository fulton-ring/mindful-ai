import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { deleteAgentMemoryThread } from '../../agent/memory/memory';
import { all, first } from '../../db/client';
import { purgeConversationExecution } from '../../execution/privacy';
import { HttpError, jsonBody, nowIso, parseBody } from '../../http';
import type { Bindings, Variables } from '../../types';
import { deleteAttachmentPrefix } from '../attachments/attachments';
import { captureConversation, captureSchema } from './capture';
import {
  conversationDeleteSucceeded,
  EXPLICIT_ARCHIVE_CONVERSATION_SQL,
  EXPLICIT_DELETE_CONVERSATION_SQL,
  EXPLICIT_DELETE_NOTE_SQL,
} from './deletion';
import { createConversation, loadConversation, requireConversation } from './repository';

export const conversationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

conversationRoutes.post('/conversations', async (c) => {
  const body = await jsonBody<{ personaId?: string }>(c).catch(() => ({}));
  return c.json(await createConversation(c.env.DB, c.get('userId'), null, body), 201);
});

conversationRoutes.post('/notes/:id/conversations', async (c) => {
  const ownerId = c.get('userId');
  const note = await first<{ id: string }>(
    c.env.DB.prepare('SELECT id FROM notes WHERE id=? AND owner_id=?').bind(
      c.req.param('id'),
      ownerId,
    ),
  );
  if (!note) throw new HttpError(404, 'Note not found');
  // A note has at most one thread (unique index one_conversation_per_note).
  const existing = await first<{ id: string }>(
    c.env.DB.prepare('SELECT id FROM conversations WHERE note_id=? AND owner_id=?').bind(
      note.id,
      ownerId,
    ),
  );
  if (existing) throw new HttpError(409, 'Note already has a conversation');
  const body = await jsonBody<{ personaId?: string }>(c).catch(() => ({}));
  return c.json(await createConversation(c.env.DB, ownerId, note.id, body), 201);
});
conversationRoutes.get('/conversations', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  if (query.length > 200) throw new HttpError(400, 'Search is too long');
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length > 8) throw new HttpError(400, 'Use fewer search terms');
  const searchConditions = terms
    .map(() =>
      c.env.DB.dialect === 'postgres'
        ? `AND (
        strpos(lower(c.title),lower(?))>0
        OR strpos(lower(COALESCE(n.title,'')),lower(?))>0
        OR strpos(lower(COALESCE(n.markdown,'')),lower(?))>0
        OR EXISTS (
          SELECT 1 FROM messages searched
          WHERE searched.conversation_id=c.id AND searched.owner_id=c.owner_id
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(searched.ui_message::jsonb -> 'parts') part(value)
              WHERE part.value ->> 'type'='text'
                AND strpos(lower(part.value ->> 'text'),lower(?))>0)
        )
      )`
        : `AND (
        instr(lower(c.title),lower(?))>0
        OR instr(lower(COALESCE(n.title,'')),lower(?))>0
        OR instr(lower(COALESCE(n.markdown,'')),lower(?))>0
        OR EXISTS (
          SELECT 1 FROM messages searched
          WHERE searched.conversation_id=c.id AND searched.owner_id=c.owner_id
            AND EXISTS (
              SELECT 1 FROM json_each(searched.ui_message,'$.parts') part
              WHERE json_extract(part.value,'$.type')='text'
                AND instr(lower(json_extract(part.value,'$.text')),lower(?))>0)
        )
      )`,
    )
    .join('\n');
  const rows = await all<{
    id: string;
    note_id: string | null;
    expires_at: string;
    title: string;
    last_user_activity_at: string;
    last_message_at: string | null;
    note_updated_at: string | null;
  }>(
    c.env.DB.prepare(
      // A conversation attached to a note takes its name from that note: the
      // note is the durable object and the thread is a child of it.
      `SELECT c.id,c.note_id,c.expires_at,c.last_user_activity_at,n.updated_at AS note_updated_at,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=c.id) AS last_message_at,
         COALESCE(NULLIF(TRIM(n.title),''),c.title) AS title
         FROM conversations c
         LEFT JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id
         WHERE c.owner_id=? AND ((c.status='active' AND c.expires_at>?) OR c.note_id IS NOT NULL)
         ${searchConditions}
         ORDER BY c.last_user_activity_at DESC`,
    ).bind(c.get('userId'), nowIso(), ...terms.flatMap((term) => [term, term, term, term])),
  );
  return c.json(
    rows.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      expiresAt: row.expires_at,
      title: row.title,
      updatedAt: row.last_user_activity_at,
      lastMessageAt: row.last_message_at ?? null,
      noteUpdatedAt: row.note_updated_at ?? null,
    })),
  );
});
conversationRoutes.get('/conversations/:id', async (c) =>
  c.json(
    await loadConversation(c.env.DB, c.get('userId'), c.req.param('id'), {
      branchId: c.req.query('branch'),
    }),
  ),
);
conversationRoutes.post('/conversations/:id/capture', async (c) => {
  const input = await parseBody(c, captureSchema, 'Invalid note capture');
  const result = await captureConversation(c.env.DB, c.get('userId'), c.req.param('id'), input);
  const payload = { conversation: result.conversation, note: result.note };
  return result.created ? c.json(payload, 201) : c.json(payload);
});
const titleSchema = z.object({ title: z.string().trim().min(1).max(200) });
const flagSchema = z.object({ enabled: z.boolean() }).strict();
const noteLinkSchema = z.object({ noteId: z.string().min(1).nullable() });
const NO_STREAMING_TURN =
  "NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming')";

conversationRoutes.patch('/conversations/:id', async (c) => {
  const { title } = await parseBody(c, titleSchema, 'Invalid conversation title');
  const ownerId = c.get('userId');
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    'UPDATE conversations SET title=? WHERE id=? AND owner_id=?',
  )
    .bind(title, id, ownerId)
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'Conversation not found');
  return c.json(await loadConversation(c.env.DB, ownerId, id));
});

/** Per-thread toggles can't change under a reply that is already being written. */
async function setConversationFlag(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  conversationId: string,
  column: 'learning_checks_enabled' | 'web_search_enabled',
  label: string,
) {
  const ownerId = c.get('userId');
  const { id } = await requireConversation(c.env.DB, ownerId, conversationId);
  const { enabled } = await parseBody(c, flagSchema, `Invalid ${label} preference`);
  const result = await c.env.DB.prepare(
    `UPDATE conversations SET ${column}=? WHERE id=? AND owner_id=? AND ${NO_STREAMING_TURN}`,
  )
    .bind(enabled ? 1 : 0, id, ownerId, id, ownerId)
    .run();
  if (result.meta.changes !== 1)
    throw new HttpError(409, `Wait for the current reply to finish before changing ${label}`);
  return { id, ownerId, enabled };
}

conversationRoutes.patch('/conversations/:id/learning-checks', async (c) => {
  const { id, ownerId, enabled } = await setConversationFlag(
    c,
    c.req.param('id'),
    'learning_checks_enabled',
    'learning checks',
  );
  if (!enabled)
    await c.env.DB.prepare(
      "UPDATE interventions SET status='invalidated' WHERE conversation_id=? AND owner_id=? AND kind='learning_check' AND status='pending'",
    )
      .bind(id, ownerId)
      .run();
  return c.json({ learningChecksEnabled: enabled });
});
conversationRoutes.patch('/conversations/:id/web-search', async (c) => {
  const { enabled } = await setConversationFlag(
    c,
    c.req.param('id'),
    'web_search_enabled',
    'web search',
  );
  return c.json({ webSearchEnabled: enabled });
});
conversationRoutes.patch('/conversations/:id/note', async (c) => {
  const ownerId = c.get('userId');
  const conversation = await loadConversation(c.env.DB, ownerId, c.req.param('id'));
  const { noteId } = await parseBody(c, noteLinkSchema, 'Invalid note attachment');
  if (conversation.noteId !== null && noteId !== conversation.noteId)
    throw new HttpError(409, 'Conversation note ownership cannot be changed');
  if (noteId !== null) {
    const note = await first<{ id: string }>(
      c.env.DB.prepare('SELECT id FROM notes WHERE id=? AND owner_id=?').bind(noteId, ownerId),
    );
    if (!note) throw new HttpError(404, 'Note not found');
    const existingOwner = await first<{ id: string }>(
      c.env.DB.prepare(
        'SELECT id FROM conversations WHERE note_id=? AND owner_id=? AND id<>? LIMIT 1',
      ).bind(noteId, ownerId, conversation.id),
    );
    if (existingOwner) throw new HttpError(409, 'Note is already linked to another conversation');
  }
  const streaming = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming'",
    ).bind(conversation.id, ownerId),
  );
  if (streaming) throw new HttpError(409, 'Cannot change note while a turn is streaming');
  await c.env.DB.prepare('UPDATE conversations SET note_id=? WHERE id=? AND owner_id=?')
    .bind(noteId, conversation.id, ownerId)
    .run();
  conversation.noteId = noteId;
  return c.json(conversation);
});
conversationRoutes.delete('/conversations/:id', async (c) => {
  const ownerId = c.get('userId');
  const conversation = await requireConversation(c.env.DB, ownerId, c.req.param('id'));
  if (c.env.FILES) await deleteAttachmentPrefix(c.env.FILES, ownerId, conversation.id);
  const keepNote = c.req.query('keepNote') === '1';
  await c.env.DB.prepare("UPDATE conversations SET status='expired' WHERE id=? AND owner_id=?")
    .bind(conversation.id, ownerId)
    .run();
  await purgeConversationExecution(c.env, ownerId, conversation.id);
  await deleteAgentMemoryThread(c.env.DB, ownerId, conversation.id);
  const results = await c.env.DB.batch(
    keepNote
      ? [c.env.DB.prepare(EXPLICIT_ARCHIVE_CONVERSATION_SQL).bind(conversation.id, ownerId)]
      : [
          c.env.DB.prepare(EXPLICIT_DELETE_NOTE_SQL).bind(ownerId, conversation.id, ownerId),
          c.env.DB.prepare(EXPLICIT_DELETE_CONVERSATION_SQL).bind(conversation.id, ownerId),
        ],
  );
  if (!conversationDeleteSucceeded(results.at(-1)))
    throw new HttpError(409, 'Conversation ownership changed during deletion');
  return c.body(null, 204);
});
