import type {
  Annotation,
  Conversation,
  Message,
  MessageHighlight,
  MessageSource,
  Note,
  ProvenanceSpan,
  ToolActivity,
} from '@walden/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { deleteAgentMemoryThread } from '../agent/memory';
import { all, first, parseJson } from '../db/client';
import { HttpError, jsonBody, newId, nowIso } from '../http';
import type { Bindings, Variables } from '../types';
import { abortActiveTurnsForConversation } from './active-turns';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPLICIT_DELETE_CONVERSATION_SQL = `DELETE FROM conversations
  WHERE id=? AND owner_id=? AND note_id IS NULL`;
export const EXPLICIT_DELETE_NOTE_SQL = `DELETE FROM notes
  WHERE owner_id=? AND id=(
    SELECT c.note_id FROM conversations c
    WHERE c.id=? AND c.owner_id=?
    AND NOT EXISTS (
      SELECT 1 FROM conversations sibling
      WHERE sibling.note_id=c.note_id AND sibling.owner_id=c.owner_id AND sibling.id<>c.id
    )
  )`;
export const conversationDeleteSucceeded = (result: D1Result | undefined) =>
  (result?.meta.changes ?? 0) > 0;
type ConversationRow = {
  id: string;
  title: string;
  note_id: string | null;
  expires_at: string;
  learning_checks_enabled: number;
  web_search_enabled: number;
  status: string;
};
type BranchRow = {
  id: string;
  head_message_id: string | null;
  forked_from_message_id: string | null;
  expires_at: string;
  status: string;
};
type MessageRow = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  created_at: string;
  agent_highlights_json: string;
  activity_json: string;
  incomplete: number;
  highlights_json: string;
  persona_name: string | null;
};

async function purgeConversationState(
  db: D1Database,
  ownerId: string,
  conversationId: string,
): Promise<void> {
  await deleteAgentMemoryThread(db, ownerId, conversationId);
  await db.batch([
    db
      .prepare('DELETE FROM interventions WHERE conversation_id=? AND owner_id=?')
      .bind(conversationId, ownerId),
    db
      .prepare('DELETE FROM messages WHERE conversation_id=? AND owner_id=?')
      .bind(conversationId, ownerId),
    db
      .prepare('DELETE FROM turns WHERE conversation_id=? AND owner_id=?')
      .bind(conversationId, ownerId),
    db
      .prepare("UPDATE conversations SET status='expired' WHERE id=? AND owner_id=?")
      .bind(conversationId, ownerId),
  ]);
}

export async function loadConversation(
  db: D1Database,
  ownerId: string,
  id: string,
  options: { renewExpired?: boolean; branchId?: string } = {},
): Promise<Conversation> {
  const row = await first<ConversationRow>(
    db
      .prepare(
        // Same ownership rule as the list: the note names the thread.
        `SELECT c.id,COALESCE(NULLIF(TRIM(n.title),''),c.title) AS title,c.note_id,c.expires_at,c.learning_checks_enabled,c.web_search_enabled,c.status
           FROM conversations c
           LEFT JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id
           WHERE c.id=? AND c.owner_id=?`,
      )
      .bind(id, ownerId),
  );
  if (!row) throw new HttpError(404, 'Conversation not found');
  let branches = await all<BranchRow>(
    db
      .prepare(
        'SELECT id,head_message_id,forked_from_message_id,expires_at,status FROM conversation_branches WHERE conversation_id=? AND owner_id=? ORDER BY is_default DESC,created_at',
      )
      .bind(id, ownerId),
  );
  let branch = options.branchId
    ? branches.find(({ id: branchId }) => branchId === options.branchId)
    : (branches.find(({ status, expires_at }) => status === 'active' && expires_at > nowIso()) ??
      branches[0]);
  if (!branch) throw new HttpError(404, 'Branch not found');
  if (branch.status !== 'active' || branch.expires_at <= nowIso()) {
    if (options.branchId) throw new HttpError(410, 'Branch expired');
    if (row.note_id === null || !options.renewExpired) {
      if (!branches.some(({ status, expires_at }) => status === 'active' && expires_at > nowIso()))
        await purgeConversationState(db, ownerId, id);
      if (row.note_id === null) throw new HttpError(410, 'Conversation expired');
      return {
        id: row.id,
        title: row.title,
        noteId: row.note_id,
        messages: [],
        expiresAt: branch.expires_at,
        learningChecksEnabled: Boolean(row.learning_checks_enabled),
        webSearchEnabled: row.web_search_enabled !== 0,
        branchId: branch.id,
        branches: [],
      };
    }
    await purgeConversationState(db, ownerId, id);
    const renewedAt = nowIso();
    const renewedExpiry = new Date(Date.now() + RETENTION_MS).toISOString();
    await db.batch([
      db
        .prepare(
          "UPDATE conversation_branches SET status='active',head_message_id=NULL,forked_from_message_id=NULL,last_user_activity_at=?,expires_at=? WHERE id=? AND owner_id=?",
        )
        .bind(renewedAt, renewedExpiry, branch.id, ownerId),
      db
        .prepare(
          "UPDATE conversations SET status='active',last_user_activity_at=?,expires_at=? WHERE id=? AND owner_id=?",
        )
        .bind(renewedAt, renewedExpiry, id, ownerId),
    ]);
    branch = { ...branch, status: 'active', head_message_id: null, expires_at: renewedExpiry };
    branches = branches.map((item) => (item.id === branch?.id ? branch : item));
  }
  const messages = (
    await all<MessageRow>(
      db
        .prepare(
          `WITH RECURSIVE path(id,parent_message_id,depth) AS (
             SELECT id,parent_message_id,0 FROM messages WHERE id=? AND conversation_id=? AND owner_id=?
             UNION ALL
             SELECT m.id,m.parent_message_id,path.depth+1 FROM messages m JOIN path ON m.id=path.parent_message_id
             WHERE m.conversation_id=? AND m.owner_id=?
           )
           SELECT m.id,m.role,m.content,m.reasoning,m.created_at,m.activity_json,m.incomplete,m.persona_name,
             COALESCE((SELECT json_group_array(json_object('start',ordered.start,'end',ordered.end,'quote',ordered.quote,'color',ordered.color,'origin',ordered.origin))
               FROM (SELECT h.start,h.end,h.quote,h.color,h.origin FROM message_highlights h
                 WHERE h.message_id=m.id AND h.owner_id=m.owner_id AND h.origin='user'
                 ORDER BY h.updated_at ASC,h.rowid ASC) ordered),'[]') AS highlights_json,
             COALESCE((SELECT json_group_array(json_object('quote',a.quote,'kind',a.kind,'start',a.start))
               FROM (SELECT h.quote,h.kind,h.start FROM message_highlights h
                 WHERE h.message_id=m.id AND h.owner_id=m.owner_id AND h.origin='agent'
                 ORDER BY h.start ASC) a),'[]') AS agent_highlights_json
           FROM path JOIN messages m ON m.id=path.id ORDER BY path.depth DESC`,
        )
        .bind(branch.head_message_id, id, ownerId, id, ownerId),
    )
  ).map<Message>((message) => {
    const activity = parseJson<{
      tools?: ToolActivity[];
      sources?: MessageSource[];
      contextCompacted?: boolean;
    }>(message.activity_json, {});
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      createdAt: message.created_at,
      ...(message.persona_name ? { personaName: message.persona_name } : {}),
      annotations: parseJson<Array<{ quote: string; kind: string; start: number }>>(
        message.agent_highlights_json,
        [],
      ).map((row) => ({
        id: `agent:${message.id}:${row.start}`,
        quote: row.quote,
        kind: row.kind as Annotation['kind'],
        whose: 'assistant' as const,
      })),
      highlights: parseJson<MessageHighlight[]>(message.highlights_json, []),
      ...(activity.tools?.length ? { tools: activity.tools } : {}),
      ...(activity.sources?.length ? { sources: activity.sources } : {}),
      ...(activity.contextCompacted ? { contextCompacted: true } : {}),
      incomplete: Boolean(message.incomplete),
    };
  });
  return {
    id: row.id,
    title: row.title,
    noteId: row.note_id,
    messages,
    expiresAt: branch.expires_at,
    learningChecksEnabled: Boolean(row.learning_checks_enabled),
    webSearchEnabled: row.web_search_enabled !== 0,
    branchId: branch.id,
    branches: branches
      .filter(({ status, expires_at }) => status === 'active' && expires_at > nowIso())
      .map((item) => ({
        id: item.id,
        forkedFromMessageId: item.forked_from_message_id,
        headMessageId: item.head_message_id,
        expiresAt: item.expires_at,
      })),
  };
}

export const conversationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const captureSchema = z
  .object({
    text: z.string().min(1).max(200_000),
    verbatim: z.boolean(),
    operationId: z.string().min(1),
  })
  .strict();
type CapturedNoteRow = {
  id: string;
  markdown: string;
  revision: number;
  provenance_json: string;
  created_at: string;
  updated_at: string;
};

const capturedNote = (row: CapturedNoteRow, title: string): Note => ({
  id: row.id,
  title,
  markdown: row.markdown,
  revision: row.revision,
  provenance: parseJson<ProvenanceSpan[]>(row.provenance_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const captureReplay = (
  db: D1Database,
  conversationId: string,
  ownerId: string,
  operationId: string,
) =>
  first<CapturedNoteRow>(
    db
      .prepare(
        'SELECT n.id,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at FROM conversations c JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id JOIN note_edits e ON e.note_id=n.id AND e.owner_id=n.owner_id WHERE c.id=? AND c.owner_id=? AND e.operation_id=?',
      )
      .bind(conversationId, ownerId, operationId),
  );
async function createConversation(
  db: D1Database,
  ownerId: string,
  noteId: string | null,
  body: { personaId?: string },
): Promise<Conversation> {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  const id = newId();
  const branchId = newId();
  await db
    .prepare(
      'INSERT INTO conversations (id,owner_id,note_id,persona_id,title,last_user_activity_at,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      id,
      ownerId,
      noteId,
      body.personaId ?? 'thinking-partner',
      'New thread',
      createdAt,
      expiresAt,
      'active',
      createdAt,
    )
    .run();
  await db
    .prepare(
      'INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,last_user_activity_at,expires_at,created_at) VALUES (?,?,?,1,?,?,?)',
    )
    .bind(branchId, id, ownerId, createdAt, expiresAt, createdAt)
    .run();
  return {
    id,
    title: 'New thread',
    noteId,
    messages: [],
    expiresAt,
    learningChecksEnabled: true,
    webSearchEnabled: true,
    branchId,
    branches: [{ id: branchId, forkedFromMessageId: null, headMessageId: null, expiresAt }],
  };
}

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
  const body = await jsonBody<{ personaId?: string }>(c).catch(() => ({}));
  return c.json(await createConversation(c.env.DB, ownerId, note.id, body), 201);
});
conversationRoutes.get('/conversations', async (c) => {
  const rows = await all<{
    id: string;
    note_id: string | null;
    expires_at: string;
    title: string;
    last_user_activity_at: string;
  }>(
    c.env.DB.prepare(
      // A conversation attached to a note takes its name from that note: the
      // note is the durable object and the thread is a child of it.
      `SELECT c.id,c.note_id,c.expires_at,c.last_user_activity_at,
         COALESCE(NULLIF(TRIM(n.title),''),c.title) AS title
         FROM conversations c
         LEFT JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id
         WHERE c.owner_id=? AND ((c.status='active' AND c.expires_at>?) OR c.note_id IS NOT NULL)
         ORDER BY c.last_user_activity_at DESC`,
    ).bind(c.get('userId'), nowIso()),
  );
  return c.json(
    rows.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      expiresAt: row.expires_at,
      title: row.title,
      updatedAt: row.last_user_activity_at,
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
  const parsed = captureSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid note capture', parsed.error.flatten());
  const ownerId = c.get('userId');
  const conversationId = c.req.param('id');
  const replay = await captureReplay(c.env.DB, conversationId, ownerId, parsed.data.operationId);
  if (replay) {
    const conversation = await loadConversation(c.env.DB, ownerId, conversationId);
    return c.json({ conversation, note: capturedNote(replay, conversation.title) });
  }
  const conversation = await loadConversation(c.env.DB, ownerId, conversationId);
  if (conversation.noteId) throw new HttpError(409, 'Conversation already has a note');
  const streaming = await first<{ id: string }>(
    c.env.DB.prepare(
      "SELECT id FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming'",
    ).bind(conversationId, ownerId),
  );
  if (streaming) throw new HttpError(409, 'Cannot capture while a turn is streaming');

  const now = nowIso();
  const noteId = newId();
  const provenance: ProvenanceSpan[] = [
    {
      from: 0,
      to: parsed.data.text.length,
      origin: parsed.data.verbatim ? 'agent' : 'user',
      verbatim: parsed.data.verbatim,
      ...(parsed.data.verbatim ? { captureId: parsed.data.operationId } : {}),
    },
  ];
  const provenanceJson = JSON.stringify(provenance);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title)
       SELECT ?,?,'',0,'[]',?,?,? WHERE EXISTS (
         SELECT 1 FROM conversations c WHERE c.id=? AND c.owner_id=? AND c.note_id IS NULL
         AND c.status='active' AND c.expires_at>?
         AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id=c.id AND t.owner_id=c.owner_id AND t.status='streaming')
       )`,
    ).bind(noteId, ownerId, now, now, conversation.title, conversationId, ownerId, now),
    c.env.DB.prepare(
      `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,created_at)
       SELECT ?,id,owner_id,?,0,1,?,'','[]',?,?,?,? FROM notes WHERE id=? AND owner_id=? AND revision=0`,
    ).bind(
      newId(),
      parsed.data.operationId,
      conversation.title,
      conversation.title,
      parsed.data.text,
      provenanceJson,
      now,
      noteId,
      ownerId,
    ),
    c.env.DB.prepare(
      'UPDATE notes SET markdown=?,provenance_json=?,revision=1,updated_at=? WHERE id=? AND owner_id=? AND revision=0 AND EXISTS (SELECT 1 FROM note_edits WHERE note_id=? AND owner_id=? AND operation_id=?)',
    ).bind(
      parsed.data.text,
      provenanceJson,
      now,
      noteId,
      ownerId,
      noteId,
      ownerId,
      parsed.data.operationId,
    ),
    c.env.DB.prepare(
      `UPDATE conversations SET note_id=? WHERE id=? AND owner_id=? AND note_id IS NULL
       AND status='active' AND expires_at>?
       AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=conversations.id AND owner_id=conversations.owner_id AND status='streaming')
       AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=1)`,
    ).bind(noteId, conversationId, ownerId, now, noteId, ownerId),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) {
    const racedReplay = await captureReplay(
      c.env.DB,
      conversationId,
      ownerId,
      parsed.data.operationId,
    );
    if (racedReplay) {
      const current = await loadConversation(c.env.DB, ownerId, conversationId);
      return c.json({ conversation: current, note: capturedNote(racedReplay, current.title) });
    }
    throw new HttpError(409, 'Conversation changed during capture');
  }
  conversation.noteId = noteId;
  return c.json(
    {
      conversation,
      note: {
        id: noteId,
        title: conversation.title,
        markdown: parsed.data.text,
        revision: 1,
        provenance,
        createdAt: now,
        updatedAt: now,
      } satisfies Note,
    },
    201,
  );
});
conversationRoutes.patch('/conversations/:id', async (c) => {
  const body = await jsonBody<unknown>(c);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('title' in body) ||
    typeof body.title !== 'string' ||
    body.title.trim().length === 0 ||
    body.title.length > 200
  )
    throw new HttpError(400, 'Invalid conversation title');
  const ownerId = c.get('userId');
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    'UPDATE conversations SET title=? WHERE id=? AND owner_id=?',
  )
    .bind(body.title.trim(), id, ownerId)
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'Conversation not found');
  return c.json(await loadConversation(c.env.DB, ownerId, id));
});
conversationRoutes.patch('/conversations/:id/learning-checks', async (c) => {
  const ownerId = c.get('userId');
  const conversation = await loadConversation(c.env.DB, ownerId, c.req.param('id'));
  const body = z
    .object({ enabled: z.boolean() })
    .strict()
    .safeParse(await jsonBody<unknown>(c));
  if (!body.success) throw new HttpError(400, 'Invalid learning-check preference');
  const result = await c.env.DB.prepare(
    `UPDATE conversations SET learning_checks_enabled=? WHERE id=? AND owner_id=? AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming')`,
  )
    .bind(body.data.enabled ? 1 : 0, conversation.id, ownerId, conversation.id, ownerId)
    .run();
  if (result.meta.changes !== 1)
    throw new HttpError(
      409,
      'Wait for the current reply to finish before changing learning checks',
    );
  if (!body.data.enabled)
    await c.env.DB.prepare(
      "UPDATE interventions SET status='invalidated' WHERE conversation_id=? AND owner_id=? AND kind='learning_check' AND status='pending'",
    )
      .bind(conversation.id, ownerId)
      .run();
  return c.json({ learningChecksEnabled: body.data.enabled });
});
conversationRoutes.patch('/conversations/:id/web-search', async (c) => {
  const ownerId = c.get('userId');
  const conversation = await loadConversation(c.env.DB, ownerId, c.req.param('id'));
  const body = z
    .object({ enabled: z.boolean() })
    .strict()
    .safeParse(await jsonBody<unknown>(c));
  if (!body.success) throw new HttpError(400, 'Invalid web-search preference');
  const result = await c.env.DB.prepare(
    `UPDATE conversations SET web_search_enabled=? WHERE id=? AND owner_id=? AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming')`,
  )
    .bind(body.data.enabled ? 1 : 0, conversation.id, ownerId, conversation.id, ownerId)
    .run();
  if (result.meta.changes !== 1)
    throw new HttpError(409, 'Wait for the current reply to finish before changing web search');
  return c.json({ webSearchEnabled: body.data.enabled });
});
conversationRoutes.patch('/conversations/:id/note', async (c) => {
  const ownerId = c.get('userId');
  const conversation = await loadConversation(c.env.DB, ownerId, c.req.param('id'));
  const body = await jsonBody<unknown>(c);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('noteId' in body) ||
    (body.noteId !== null && typeof body.noteId !== 'string')
  )
    throw new HttpError(400, 'Invalid note attachment');
  const noteId = body.noteId;
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
  const conversation = await first<{ id: string }>(
    c.env.DB.prepare('SELECT id FROM conversations WHERE id=? AND owner_id=?').bind(
      c.req.param('id'),
      ownerId,
    ),
  );
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  abortActiveTurnsForConversation(conversation.id, 'conversation deleted');
  await deleteAgentMemoryThread(c.env.DB, ownerId, conversation.id);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(EXPLICIT_DELETE_NOTE_SQL).bind(ownerId, conversation.id, ownerId),
    c.env.DB.prepare(EXPLICIT_DELETE_CONVERSATION_SQL).bind(conversation.id, ownerId),
  ]);
  if (!conversationDeleteSucceeded(results.at(-1)))
    throw new HttpError(409, 'Conversation ownership changed during deletion');
  return c.body(null, 204);
});

export async function purgeExpiredConversations(db: D1Database): Promise<number> {
  const expiredAt = nowIso();
  const expired = await all<{ id: string; owner_id: string }>(
    db.prepare('SELECT id,owner_id FROM conversations WHERE expires_at<=?').bind(expiredAt),
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
