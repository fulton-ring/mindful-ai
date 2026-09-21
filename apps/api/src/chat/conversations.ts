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
/** Archive removes the transcript container while leaving its durable note intact. */
export const EXPLICIT_ARCHIVE_CONVERSATION_SQL = `DELETE FROM conversations
  WHERE id=? AND owner_id=?`;
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

async function loadConversationRow(
  db: D1Database,
  ownerId: string,
  id: string,
): Promise<ConversationRow> {
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
  return row;
}

async function loadConversationBranches(
  db: D1Database,
  ownerId: string,
  id: string,
): Promise<BranchRow[]> {
  return all<BranchRow>(
    db
      .prepare(
        'SELECT id,head_message_id,forked_from_message_id,expires_at,status FROM conversation_branches WHERE conversation_id=? AND owner_id=? ORDER BY is_default DESC,created_at',
      )
      .bind(id, ownerId),
  );
}

const isActiveBranch = ({ status, expires_at }: BranchRow) =>
  status === 'active' && expires_at > nowIso();

type ResolvedBranch = {
  branch: BranchRow;
  branches: BranchRow[];
  expiredConversation?: Conversation;
};

async function renewConversation(
  db: D1Database,
  ownerId: string,
  id: string,
  branch: BranchRow,
  branches: BranchRow[],
): Promise<ResolvedBranch> {
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
  const renewedBranch = {
    ...branch,
    status: 'active',
    head_message_id: null,
    expires_at: renewedExpiry,
  };
  return {
    branch: renewedBranch,
    branches: branches.map((item) => (item.id === renewedBranch.id ? renewedBranch : item)),
  };
}

async function resolveConversationBranch(
  db: D1Database,
  ownerId: string,
  id: string,
  row: ConversationRow,
  branches: BranchRow[],
  options: { renewExpired?: boolean; branchId?: string },
): Promise<ResolvedBranch> {
  const branch = options.branchId
    ? branches.find(({ id: branchId }) => branchId === options.branchId)
    : (branches.find(isActiveBranch) ?? branches[0]);
  if (!branch) throw new HttpError(404, 'Branch not found');
  if (branch.status === 'active' && branch.expires_at > nowIso()) return { branch, branches };

  const hasActiveBranch = branches.some(isActiveBranch);
  // A new message may restart a fully expired note-backed conversation, even
  // when the client supplies the branch shown in its empty transcript.
  if (options.branchId && (!options.renewExpired || row.note_id === null || hasActiveBranch))
    throw new HttpError(410, 'Branch expired');
  if (row.note_id === null || !options.renewExpired) {
    if (!hasActiveBranch) await purgeConversationState(db, ownerId, id);
    if (row.note_id === null) throw new HttpError(410, 'Conversation expired');
    return {
      branch,
      branches: [],
      expiredConversation: {
        id: row.id,
        title: row.title,
        noteId: row.note_id,
        messages: [],
        expiresAt: branch.expires_at,
        learningChecksEnabled: Boolean(row.learning_checks_enabled),
        webSearchEnabled: row.web_search_enabled !== 0,
        branchId: branch.id,
        branches: [],
      },
    };
  }
  return renewConversation(db, ownerId, id, branch, branches);
}

function mapConversationMessage(message: MessageRow): Message {
  const activity = parseJson<{
    tools?: ToolActivity[];
    sources?: MessageSource[];
    contextCompacted?: boolean;
    learningCheck?: Message['learningCheck'];
    learningCheckResponse?: Message['learningCheckResponse'];
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
    ...(activity.learningCheck ? { learningCheck: activity.learningCheck } : {}),
    ...(activity.learningCheckResponse
      ? { learningCheckResponse: activity.learningCheckResponse }
      : {}),
    incomplete: Boolean(message.incomplete),
  };
}

async function loadConversationMessages(
  db: D1Database,
  ownerId: string,
  id: string,
  headMessageId: string | null,
): Promise<Message[]> {
  const rows = await all<MessageRow>(
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
      .bind(headMessageId, id, ownerId, id, ownerId),
  );
  return rows.map(mapConversationMessage);
}

function buildConversation(
  row: ConversationRow,
  branch: BranchRow,
  branches: BranchRow[],
  messages: Message[],
): Conversation {
  return {
    id: row.id,
    title: row.title,
    noteId: row.note_id,
    messages,
    expiresAt: branch.expires_at,
    learningChecksEnabled: Boolean(row.learning_checks_enabled),
    webSearchEnabled: row.web_search_enabled !== 0,
    branchId: branch.id,
    branches: branches.filter(isActiveBranch).map((item) => ({
      id: item.id,
      forkedFromMessageId: item.forked_from_message_id,
      headMessageId: item.head_message_id,
      expiresAt: item.expires_at,
    })),
  };
}

export async function loadConversation(
  db: D1Database,
  ownerId: string,
  id: string,
  options: { renewExpired?: boolean; branchId?: string } = {},
): Promise<Conversation> {
  const row = await loadConversationRow(db, ownerId, id);
  const resolved = await resolveConversationBranch(
    db,
    ownerId,
    id,
    row,
    await loadConversationBranches(db, ownerId, id),
    options,
  );
  if (resolved.expiredConversation) return resolved.expiredConversation;
  const messages = await loadConversationMessages(db, ownerId, id, resolved.branch.head_message_id);
  return buildConversation(row, resolved.branch, resolved.branches, messages);
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
type CaptureInput = z.infer<typeof captureSchema>;
type CaptureResult = { conversation: Conversation; note: Note; created: boolean };

async function persistCapturedNote(
  db: D1Database,
  ownerId: string,
  conversationId: string,
  conversation: Conversation,
  input: CaptureInput,
) {
  const now = nowIso();
  const noteId = newId();
  const provenance: ProvenanceSpan[] = [
    {
      from: 0,
      to: input.text.length,
      origin: input.verbatim ? 'agent' : 'user',
      verbatim: input.verbatim,
      ...(input.verbatim ? { captureId: input.operationId } : {}),
    },
  ];
  const provenanceJson = JSON.stringify(provenance);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title)
         SELECT ?,?,'',0,'[]',?,?,? WHERE EXISTS (
           SELECT 1 FROM conversations c WHERE c.id=? AND c.owner_id=? AND c.note_id IS NULL
           AND c.status='active' AND c.expires_at>?
           AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id=c.id AND t.owner_id=c.owner_id AND t.status='streaming')
         )`,
      )
      .bind(noteId, ownerId, now, now, conversation.title, conversationId, ownerId, now),
    db
      .prepare(
        `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,created_at)
         SELECT ?,id,owner_id,?,0,1,?,'','[]',?,?,?,? FROM notes WHERE id=? AND owner_id=? AND revision=0`,
      )
      .bind(
        newId(),
        input.operationId,
        conversation.title,
        conversation.title,
        input.text,
        provenanceJson,
        now,
        noteId,
        ownerId,
      ),
    db
      .prepare(
        'UPDATE notes SET markdown=?,provenance_json=?,revision=1,updated_at=? WHERE id=? AND owner_id=? AND revision=0 AND EXISTS (SELECT 1 FROM note_edits WHERE note_id=? AND owner_id=? AND operation_id=?)',
      )
      .bind(input.text, provenanceJson, now, noteId, ownerId, noteId, ownerId, input.operationId),
    db
      .prepare(
        `UPDATE conversations SET note_id=? WHERE id=? AND owner_id=? AND note_id IS NULL
         AND status='active' AND expires_at>?
         AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id=conversations.id AND owner_id=conversations.owner_id AND status='streaming')
         AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=1)`,
      )
      .bind(noteId, conversationId, ownerId, now, noteId, ownerId),
  ]);
  return { now, noteId, provenance, results };
}

async function captureConversation(
  db: D1Database,
  ownerId: string,
  conversationId: string,
  input: CaptureInput,
): Promise<CaptureResult> {
  const replay = await captureReplay(db, conversationId, ownerId, input.operationId);
  if (replay) {
    const conversation = await loadConversation(db, ownerId, conversationId);
    return { conversation, note: capturedNote(replay, conversation.title), created: false };
  }
  const conversation = await loadConversation(db, ownerId, conversationId);
  if (conversation.noteId) throw new HttpError(409, 'Conversation already has a note');
  const streaming = await first<{ id: string }>(
    db
      .prepare("SELECT id FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming'")
      .bind(conversationId, ownerId),
  );
  if (streaming) throw new HttpError(409, 'Cannot capture while a turn is streaming');

  const persisted = await persistCapturedNote(db, ownerId, conversationId, conversation, input);
  if (persisted.results.some((result) => result.meta.changes !== 1)) {
    const racedReplay = await captureReplay(db, conversationId, ownerId, input.operationId);
    if (racedReplay) {
      const current = await loadConversation(db, ownerId, conversationId);
      return {
        conversation: current,
        note: capturedNote(racedReplay, current.title),
        created: false,
      };
    }
    throw new HttpError(409, 'Conversation changed during capture');
  }
  conversation.noteId = persisted.noteId;
  return {
    conversation,
    note: {
      id: persisted.noteId,
      title: conversation.title,
      markdown: input.text,
      revision: 1,
      provenance: persisted.provenance,
      createdAt: persisted.now,
      updatedAt: persisted.now,
    },
    created: true,
  };
}

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
  const query = c.req.query('q')?.trim() ?? '';
  if (query.length > 200) throw new HttpError(400, 'Search is too long');
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length > 8) throw new HttpError(400, 'Use fewer search terms');
  const searchConditions = terms
    .map(
      () => `AND (
        instr(lower(c.title),lower(?))>0
        OR instr(lower(COALESCE(n.title,'')),lower(?))>0
        OR instr(lower(COALESCE(n.markdown,'')),lower(?))>0
        OR EXISTS (
          SELECT 1 FROM messages searched
          WHERE searched.conversation_id=c.id AND searched.owner_id=c.owner_id
            AND instr(lower(searched.content),lower(?))>0
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
  const parsed = captureSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid note capture', parsed.error.flatten());
  const result = await captureConversation(
    c.env.DB,
    c.get('userId'),
    c.req.param('id'),
    parsed.data,
  );
  const payload = { conversation: result.conversation, note: result.note };
  return result.created ? c.json(payload, 201) : c.json(payload);
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
  const keepNote = c.req.query('keepNote') === '1';
  abortActiveTurnsForConversation(
    conversation.id,
    keepNote ? 'conversation archived' : 'conversation deleted',
  );
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
