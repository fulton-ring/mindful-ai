import type {
  Annotation,
  Conversation,
  MessageHighlight,
  WaldenUIMessage,
} from '@walden/contracts';
import { deleteAgentMemoryThread } from '../../agent/memory/memory';
import { all, first, parseJson } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import { HttpError, newId, nowIso } from '../../http';
import { parseStoredMessage } from '../messages';
import { DEFAULT_RETENTION_DAYS, retentionExpiry } from './retention';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type ConversationRow = {
  id: string;
  title: string;
  note_id: string | null;
  expires_at: string;
  retention_disabled: number;
  learning_checks_enabled: number;
  web_search_enabled: number;
  status: string;
};
type BranchRow = {
  id: string;
  head_message_id: string | null;
  forked_from_message_id: string | null;
  expires_at: string;
  retention_disabled: number;
  status: string;
};
type MessageRow = {
  id: string;
  ui_message: string;
  agent_highlights_json: string;
  highlights_json: string;
};

async function purgeConversationState(
  db: AppDatabase,
  ownerId: string,
  conversationId: string,
  expectedExpiry: string,
): Promise<string | null> {
  const token = newId();
  const claim = await db
    .prepare(`UPDATE conversations SET status='purging',purge_started_at=?,purge_token=?
    WHERE id=? AND owner_id=? AND status IN ('active','expired') AND retention_disabled=0
      AND expires_at=? AND expires_at<=? RETURNING id`)
    .bind(nowIso(), token, conversationId, ownerId, expectedExpiry, nowIso())
    .first();
  if (!claim) return null;
  await deleteAgentMemoryThread(db, ownerId, conversationId);
  const guard =
    "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='purging' AND purge_token=?";
  await db.batch([
    ...['interventions', 'messages', 'turns'].map((table) =>
      db
        .prepare(`DELETE FROM ${table} WHERE conversation_id IN (${guard})`)
        .bind(conversationId, ownerId, token),
    ),
    db
      .prepare(
        `UPDATE conversations SET status='expired',purge_started_at=NULL WHERE id IN (${guard})`,
      )
      .bind(conversationId, ownerId, token),
  ]);
  return token;
}

async function loadConversationRow(
  db: AppDatabase,
  ownerId: string,
  id: string,
): Promise<ConversationRow> {
  const row = await first<ConversationRow>(
    db
      .prepare(
        // Same ownership rule as the list: the note names the thread.
        `SELECT c.id,COALESCE(NULLIF(TRIM(n.title),''),c.title) AS title,c.note_id,c.expires_at,c.retention_disabled,c.learning_checks_enabled,c.web_search_enabled,c.status
           FROM conversations c
           LEFT JOIN notes n ON n.id=c.note_id AND n.owner_id=c.owner_id
           WHERE c.id=? AND c.owner_id=?`,
      )
      .bind(id, ownerId),
  );
  if (!row) throw new HttpError(404, 'Conversation not found');
  if (row.status === 'purging') throw new HttpError(410, 'Conversation deletion in progress');
  return row;
}

async function loadConversationBranches(
  db: AppDatabase,
  ownerId: string,
  id: string,
): Promise<BranchRow[]> {
  return all<BranchRow>(
    db
      .prepare(
        // Branches share their conversation's retention window.
        `SELECT b.id,b.head_message_id,b.forked_from_message_id,c.expires_at,c.retention_disabled,b.status
           FROM conversation_branches b JOIN conversations c ON c.id=b.conversation_id
           WHERE b.conversation_id=? AND b.owner_id=? ORDER BY b.is_default DESC,b.created_at`,
      )
      .bind(id, ownerId),
  );
}

const isActiveBranch = ({ status, expires_at, retention_disabled }: BranchRow) =>
  status === 'active' && (retention_disabled === 1 || expires_at > nowIso());

type ResolvedBranch = {
  branch: BranchRow;
  branches: BranchRow[];
  /** A note-backed thread whose transcript expired: shown empty until a new message renews it. */
  expired?: boolean;
};

async function renewConversation(
  db: AppDatabase,
  ownerId: string,
  id: string,
  branch: BranchRow,
  branches: BranchRow[],
  idleDays: number | null,
  token: string,
): Promise<ResolvedBranch> {
  const renewedAt = nowIso();
  const expiry = retentionExpiry(idleDays, renewedAt);
  const renewedExpiry = expiry.storedExpiresAt;
  const guard =
    "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND purge_token=?";
  const results = await db.batch([
    db
      .prepare(
        "UPDATE conversations SET status='active',last_user_activity_at=?,expires_at=?,retention_disabled=? WHERE id=? AND owner_id=? AND status='expired' AND purge_token=?",
      )
      .bind(renewedAt, renewedExpiry, expiry.retentionDisabled, id, ownerId, token),
    db
      .prepare(
        `UPDATE conversation_branches SET status=CASE WHEN id=? THEN 'active' ELSE 'expired' END,head_message_id=NULL,forked_from_message_id=NULL WHERE conversation_id IN (${guard})`,
      )
      .bind(branch.id, id, ownerId, token),
    db
      .prepare(`UPDATE conversations SET purge_token=NULL WHERE id IN (${guard})`)
      .bind(id, ownerId, token),
  ]);
  if (!results[0]?.meta.changes) throw new HttpError(410, 'Conversation changed during renewal');
  const renewedBranch = {
    ...branch,
    status: 'active',
    head_message_id: null,
    expires_at: renewedExpiry,
    retention_disabled: expiry.retentionDisabled,
  };
  return {
    branch: renewedBranch,
    branches: branches.map((item) =>
      item.id === renewedBranch.id ? renewedBranch : { ...item, status: 'expired' },
    ),
  };
}

async function resolveConversationBranch(
  db: AppDatabase,
  ownerId: string,
  id: string,
  row: ConversationRow,
  branches: BranchRow[],
  options: { renewExpired?: boolean; branchId?: string; retentionIdleDays?: number | null },
): Promise<ResolvedBranch> {
  const branch = options.branchId
    ? branches.find(({ id: branchId }) => branchId === options.branchId)
    : (branches.find(isActiveBranch) ?? branches[0]);
  if (!branch) throw new HttpError(404, 'Branch not found');
  if (isActiveBranch(branch)) return { branch, branches };

  const hasActiveBranch = branches.some(isActiveBranch);
  // A new message may restart a fully expired note-backed conversation, even
  // when the client supplies the branch shown in its empty transcript.
  if (options.branchId && (!options.renewExpired || row.note_id === null || hasActiveBranch))
    throw new HttpError(410, 'Branch expired');
  const token = await purgeConversationState(db, ownerId, id, row.expires_at);
  if (!token) {
    const current = await loadConversationRow(db, ownerId, id);
    if (
      current.status === row.status &&
      current.expires_at === row.expires_at &&
      current.retention_disabled === row.retention_disabled
    )
      throw new HttpError(410, 'Conversation expired');
    Object.assign(row, current);
    return resolveConversationBranch(
      db,
      ownerId,
      id,
      row,
      await loadConversationBranches(db, ownerId, id),
      options,
    );
  }
  if (row.note_id === null || !options.renewExpired) {
    if (row.note_id === null) throw new HttpError(410, 'Conversation expired');
    return { branch, branches: [], expired: true };
  }
  return renewConversation(
    db,
    ownerId,
    id,
    branch,
    branches,
    options.retentionIdleDays === undefined ? DEFAULT_RETENTION_DAYS : options.retentionIdleDays,
    token,
  );
}

/** The stored message with its user highlights and agent annotations attached. */
function mapConversationMessage(row: MessageRow): WaldenUIMessage {
  const message = parseStoredMessage(row.ui_message);
  const highlights = parseJson<MessageHighlight[]>(row.highlights_json, []);
  const annotations = parseJson<Array<{ quote: string; kind: string; start: number }>>(
    row.agent_highlights_json,
    [],
  ).map(
    (item): Annotation => ({
      id: `agent:${row.id}:${item.start}`,
      quote: item.quote,
      kind: item.kind as Annotation['kind'],
      whose: 'assistant',
    }),
  );
  return {
    ...message,
    metadata: {
      createdAt: '',
      ...message.metadata,
      ...(highlights.length ? { highlights } : {}),
      ...(annotations.length ? { annotations } : {}),
    },
  };
}

async function loadConversationMessages(
  db: AppDatabase,
  ownerId: string,
  id: string,
  headMessageId: string | null,
): Promise<WaldenUIMessage[]> {
  const rows = await all<MessageRow>(
    db
      .prepare(
        `WITH RECURSIVE path(id,parent_message_id,depth) AS (
           SELECT id,parent_message_id,0 FROM messages WHERE id=? AND conversation_id=? AND owner_id=?
           UNION ALL
           SELECT m.id,m.parent_message_id,path.depth+1 FROM messages m JOIN path ON m.id=path.parent_message_id
           WHERE m.conversation_id=? AND m.owner_id=?
         )
         SELECT m.id,m.ui_message,
${
  db.dialect === 'postgres'
    ? `           COALESCE((SELECT json_agg(json_build_object('start',h.start,'end',h."end",'quote',h.quote,'color',h.color,'origin',h.origin) ORDER BY h.updated_at ASC,h.start ASC,h."end" ASC)::text
             FROM message_highlights h WHERE h.message_id=m.id AND h.owner_id=m.owner_id AND h.origin='user'),'[]') AS highlights_json,
           COALESCE((SELECT json_agg(json_build_object('quote',h.quote,'kind',h.kind,'start',h.start) ORDER BY h.start ASC)::text
             FROM message_highlights h WHERE h.message_id=m.id AND h.owner_id=m.owner_id AND h.origin='agent'),'[]') AS agent_highlights_json`
    : `           COALESCE((SELECT json_group_array(json_object('start',ordered.start,'end',ordered.end,'quote',ordered.quote,'color',ordered.color,'origin',ordered.origin))
             FROM (SELECT h.start,h.end,h.quote,h.color,h.origin FROM message_highlights h
               WHERE h.message_id=m.id AND h.owner_id=m.owner_id AND h.origin='user'
               ORDER BY h.updated_at ASC,h.start ASC,h.end ASC) ordered),'[]') AS highlights_json,
           COALESCE((SELECT json_group_array(json_object('quote',a.quote,'kind',a.kind,'start',a.start))
             FROM (SELECT h.quote,h.kind,h.start FROM message_highlights h
               WHERE h.message_id=m.id AND h.owner_id=m.owner_id AND h.origin='agent'
               ORDER BY h.start ASC) a),'[]') AS agent_highlights_json`
}
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
  messages: WaldenUIMessage[],
): Conversation {
  return {
    id: row.id,
    title: row.title,
    noteId: row.note_id,
    messages,
    expiresAt: branch.retention_disabled === 1 ? null : branch.expires_at,
    learningChecksEnabled: Boolean(row.learning_checks_enabled),
    webSearchEnabled: row.web_search_enabled !== 0,
    branchId: branch.id,
    branches: branches.filter(isActiveBranch).map((item) => ({
      id: item.id,
      forkedFromMessageId: item.forked_from_message_id,
      headMessageId: item.head_message_id,
      expiresAt: item.retention_disabled === 1 ? null : item.expires_at,
    })),
  };
}

export async function loadConversation(
  db: AppDatabase,
  ownerId: string,
  id: string,
  options: { renewExpired?: boolean; branchId?: string; retentionIdleDays?: number | null } = {},
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
  const messages = resolved.expired
    ? []
    : await loadConversationMessages(db, ownerId, id, resolved.branch.head_message_id);
  return buildConversation(row, resolved.branch, resolved.branches, messages);
}

export async function createConversation(
  db: AppDatabase,
  ownerId: string,
  noteId: string | null,
  body: { personaId?: string },
  idleDays: number | null = DEFAULT_RETENTION_DAYS,
): Promise<Conversation> {
  const createdAt = nowIso();
  const expiry = retentionExpiry(idleDays, createdAt);
  const expiresAt = expiry.expiresAt;
  const id = newId();
  const branchId = newId();
  await db.batch([
    db
      .prepare(
        'INSERT INTO conversations (id,owner_id,note_id,persona_id,title,last_user_activity_at,expires_at,retention_disabled,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        ownerId,
        noteId,
        body.personaId ?? 'thinking-partner',
        'New thread',
        createdAt,
        expiry.storedExpiresAt,
        expiry.retentionDisabled,
        'active',
        createdAt,
      ),
    db
      .prepare(
        'INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,created_at) VALUES (?,?,?,1,?)',
      )
      .bind(branchId, id, ownerId, createdAt),
  ]);
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

/**
 * Ownership check for routes that only need to know the thread (and branch)
 * exists; loadConversation also loads the transcript and may renew or purge.
 */
export async function requireConversation(
  db: AppDatabase,
  ownerId: string,
  id: string,
  branchId?: string,
): Promise<{ id: string; note_id: string | null }> {
  const row = await first<{ id: string; note_id: string | null }>(
    branchId
      ? db
          .prepare(
            `SELECT c.id,c.note_id FROM conversations c
             JOIN conversation_branches b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
             WHERE c.id=? AND c.owner_id=? AND b.id=? AND c.status<>'purging'`,
          )
          .bind(id, ownerId, branchId)
      : db
          .prepare(
            "SELECT id,note_id FROM conversations WHERE id=? AND owner_id=? AND status<>'purging'",
          )
          .bind(id, ownerId),
  );
  if (!row) throw new HttpError(404, 'Conversation not found');
  return row;
}
