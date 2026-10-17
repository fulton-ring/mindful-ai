import {
  type ChatFailureCode,
  type Intervention,
  uiMessageText,
  type WaldenUIMessage,
  type WaldenUIMessageChunk,
} from '@walden/contracts';
import { withoutQuizText } from '../../agent/learning-checks';
import { first } from '../../db/client';
import type { AppDatabase, AppStatement } from '../../db/database';
import { nowIso } from '../../http';
import type { AgentTurnInput } from '../../services/types';
import { agentHighlightStatements } from '../highlights/agent-highlights';
import { buildUIMessage, metadataPatch, settleInterrupted, storedMessageJson } from '../messages';

export const TURN_BUDGET_MS = 15 * 60_000;

export type TurnRow = {
  id: string;
  request_id: string;
  conversation_id: string;
  branch_id: string;
  source_branch_id: string;
  owner_id: string;
  status: string;
  created_at: string;
  input_json: string | null;
  request_json: string | null;
  user_message_id: string | null;
  execution_generation?: number;
};
export type TurnInput = AgentTurnInput & { userMessageId: string; forked: boolean };
type Chunks = readonly WaldenUIMessageChunk[];

export const loadTurn = (db: AppDatabase, turnId: string) =>
  first<TurnRow>(db.prepare('SELECT * FROM turns WHERE id=?').bind(turnId));

function interventionOf(message: WaldenUIMessage): Intervention | undefined {
  for (const part of message.parts) if (part.type === 'data-intervention') return part.data;
  return undefined;
}

/** The turn is still streaming in a live conversation and branch; binds ?1 turn id, ?2 now. */
const ACTIVE = (
  row?: TurnRow,
) => `SELECT 1 FROM turns t JOIN conversations c ON c.id=t.conversation_id
    JOIN conversation_branches b ON b.id=t.branch_id
    WHERE t.id=?1 AND t.status='streaming'
    AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=t.owner_id AND owner.deletion_pending=0)
    AND NOT EXISTS(SELECT 1 FROM turn_cancellations cancelled WHERE cancelled.owner_id=t.owner_id AND cancelled.request_id=t.request_id)
    AND c.status='active' AND b.status='active' AND c.expires_at>?2${row ? ` AND t.execution_generation=${generationOf(row)}` : ''}`;
const COMPLETED_MESSAGE = (db: AppDatabase) =>
  db.dialect === 'postgres'
    ? "EXISTS(SELECT 1 FROM messages WHERE id=?1 AND (ui_message::jsonb #>> '{metadata,status}')='complete')"
    : "EXISTS(SELECT 1 FROM messages WHERE id=?1 AND json_extract(ui_message,'$.metadata.status')='complete')";
const generationOf = (row: TurnRow) => {
  const generation = row.execution_generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new Error('Invalid turn generation');
  return generation;
};

/** Whether the turn may still run: Stop, deletion, or expiry end it. */
export async function isTurnActive(db: AppDatabase, turnId: string, generation?: number) {
  return Boolean(
    await first(
      db
        .prepare(`${ACTIVE()}${generation === undefined ? '' : ' AND t.execution_generation=?3'}`)
        .bind(turnId, nowIso(), ...(generation === undefined ? [] : [generation])),
    ),
  );
}

/** Claims a new generation only while execution is still permitted. */
export async function claimTurnExecution(
  db: AppDatabase,
  turnId: string,
  options: { allowCancelled?: boolean } = {},
): Promise<TurnRow | null> {
  const current = await loadTurn(db, turnId);
  if (!current) return null;
  const claim = async (connection: AppDatabase) =>
    first<TurnRow>(
      connection
        .prepare(`UPDATE turns SET execution_generation=execution_generation+1
    WHERE id=?1 AND status='streaming' AND created_at>?2
    AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=turns.owner_id AND owner.deletion_pending=0)
    ${options.allowCancelled ? '' : 'AND NOT EXISTS(SELECT 1 FROM turn_cancellations c WHERE c.owner_id=turns.owner_id AND c.request_id=turns.request_id)'}
    AND EXISTS(SELECT 1 FROM conversations c JOIN conversation_branches b ON b.conversation_id=c.id
      WHERE c.id=turns.conversation_id AND b.id=turns.branch_id AND c.status='active' AND b.status='active' AND c.expires_at>?3)
    RETURNING *`)
        .bind(turnId, new Date(Date.now() - TURN_BUDGET_MS).toISOString(), nowIso()),
    );
  return db.transaction ? db.transaction(claim, [`owner:${current.owner_id}`]) : claim(db);
}

/** Persist intent before aborting the owner, including direct session Stop calls. */
export async function recordTurnCancellation(db: AppDatabase, row: TurnRow) {
  await db
    .prepare(
      'INSERT INTO turn_cancellations(owner_id,request_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
    )
    .bind(row.owner_id, row.request_id, nowIso())
    .run();
}

function interventionStatements(
  db: AppDatabase,
  row: TurnRow,
  now: string,
  intervention: Intervention | undefined,
): AppStatement[] {
  if (!intervention) return [];
  return [
    db
      .prepare(
        `UPDATE interventions SET status='superseded' WHERE branch_id=?3 AND owner_id=?4 AND status='pending' AND EXISTS (${ACTIVE(row)})`,
      )
      .bind(row.id, now, row.branch_id, row.owner_id),
    db
      .prepare(`INSERT INTO interventions(id,conversation_id,turn_id,owner_id,kind,payload_json,status,created_at,branch_id)
        SELECT ?3,?4,?1,?5,?6,?7,'pending',?2,?8 WHERE EXISTS (${ACTIVE(row)}) ON CONFLICT DO NOTHING`)
      .bind(
        row.id,
        now,
        intervention.id,
        row.conversation_id,
        row.owner_id,
        intervention.kind,
        JSON.stringify(intervention),
        row.branch_id,
      ),
  ];
}

export function completionChunks(row: TurnRow): WaldenUIMessageChunk[] {
  const input = JSON.parse(row.input_json ?? '{}') as Partial<TurnInput>;
  return [
    {
      type: 'data-turn',
      transient: true,
      data: {
        conversationId: row.conversation_id,
        branchId: row.branch_id,
        ...(row.user_message_id ? { userMessageId: row.user_message_id } : {}),
        ...(input.conversation?.title ? { title: input.conversation.title } : {}),
        ...(input.conversation?.expiresAt ? { expiresAt: input.conversation.expiresAt } : {}),
      },
    },
    {
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: metadataPatch({ status: 'complete' }),
    },
  ];
}

function completionStatements(
  db: AppDatabase,
  row: TurnRow,
  now: string,
  message: WaldenUIMessage,
) {
  return [
    db
      .prepare(`INSERT INTO messages
      (id,conversation_id,turn_id,owner_id,role,created_at,parent_message_id,origin_branch_id,ui_message)
      SELECT ?1,?3,?1,?4,'assistant',?2,?5,?6,?7 WHERE EXISTS (${ACTIVE(row)}) ON CONFLICT DO NOTHING`)
      .bind(
        row.id,
        now,
        row.conversation_id,
        row.owner_id,
        row.user_message_id,
        row.branch_id,
        storedMessageJson(message),
      ),
    ...interventionStatements(db, row, now, interventionOf(message)),
    db
      .prepare(
        `UPDATE conversation_branches SET head_message_id=?1 WHERE id=?3 AND EXISTS (${ACTIVE(row)}) AND ${COMPLETED_MESSAGE(db)}`,
      )
      .bind(row.id, now, row.branch_id),
    db
      .prepare(`UPDATE turns SET status='completed',completed_at=?2,input_json=NULL
      WHERE id=?1 AND status='streaming' AND execution_generation=${generationOf(row)} AND EXISTS (${ACTIVE(row)}) AND ${COMPLETED_MESSAGE(db)}`)
      .bind(row.id, now),
  ];
}

/**
 * Commits the streamed reply as the branch's new head, exactly once. Returns the
 * chunks that end the stream, or null when the turn was no longer active.
 */
async function completeTurnInTransaction(
  db: AppDatabase,
  row: TurnRow,
  chunks: Chunks,
): Promise<WaldenUIMessageChunk[] | null> {
  const built = withoutQuizText(await buildUIMessage(row.id, chunks));
  const now = nowIso();
  const message: WaldenUIMessage = {
    ...built,
    metadata: {
      ...built.metadata,
      createdAt: built.metadata?.createdAt ?? now,
      status: 'complete',
    },
  };
  await db.batch([
    ...completionStatements(db, row, now, message),
    ...agentHighlightStatements(db, {
      messageId: row.id,
      ownerId: row.owner_id,
      content: uiMessageText(message),
      annotations: [],
      updatedAt: now,
      completedAt: now,
      executionGeneration: generationOf(row),
    }),
  ]);
  const committed = await first<{ completed_at: string | null }>(
    db
      .prepare(
        "SELECT completed_at FROM turns WHERE id=? AND status='completed' AND execution_generation=?",
      )
      .bind(row.id, generationOf(row)),
  );
  return committed?.completed_at === now ? completionChunks(row) : null;
}

function failureChunks(
  row: TurnRow,
  chunks: Chunks,
  errorText: string,
  code: ChatFailureCode | undefined,
  now: string,
): WaldenUIMessageChunk[] {
  return [
    // A turn that failed before it started streaming still replays as a whole message.
    ...(chunks.some(({ type }) => type === 'start')
      ? []
      : [{ type: 'start' as const, messageId: row.id, messageMetadata: { createdAt: now } }]),
    {
      type: 'data-turn',
      transient: true,
      data: {
        conversationId: row.conversation_id,
        branchId: row.branch_id,
        ...(row.user_message_id ? { userMessageId: row.user_message_id } : {}),
        ...(code ? { failureCode: code } : {}),
      },
    },
    { type: 'message-metadata', messageMetadata: metadataPatch({ status: 'interrupted' }) },
    { type: 'error', errorText },
    {
      type: 'finish',
      finishReason: 'error',
      messageMetadata: metadataPatch({ status: 'interrupted' }),
    },
  ];
}

function failureStatements(
  db: AppDatabase,
  row: TurnRow,
  status: 'cancelled' | 'failed',
  now: string,
  partial: WaldenUIMessage,
) {
  const streaming = `EXISTS(SELECT 1 FROM turns WHERE id=?1 AND status='streaming' AND execution_generation=${generationOf(row)})`;
  return db.batch([
    db
      .prepare(`INSERT INTO messages(id,conversation_id,turn_id,owner_id,role,created_at,parent_message_id,origin_branch_id,ui_message)
      SELECT ?1,?2,?1,?3,'assistant',?4,?5,?6,?7 WHERE ${streaming} ON CONFLICT DO NOTHING`)
      .bind(
        row.id,
        row.conversation_id,
        row.owner_id,
        now,
        row.user_message_id,
        row.branch_id,
        storedMessageJson(partial),
      ),
    db
      .prepare(`UPDATE conversation_branches SET head_message_id=?1 WHERE id=?2 AND ${streaming}`)
      .bind(row.id, row.branch_id),
    db
      .prepare(
        `UPDATE turns SET status=?2,completed_at=?3,input_json=NULL WHERE id=?1 AND status='streaming' AND execution_generation=${generationOf(row)}`,
      )
      .bind(row.id, status, now),
    db
      .prepare(
        `UPDATE interventions SET status='invalidated' WHERE turn_id=?1 AND status='pending' AND EXISTS(SELECT 1 FROM turns WHERE id=?1 AND status IN ('failed','cancelled') AND completed_at=?2 AND execution_generation=${generationOf(row)})`,
      )
      .bind(row.id, now),
  ]);
}

/**
 * Ends a streaming turn early. The reply streamed so far is kept as an
 * interrupted message. Returns the chunks that end the stream, or null when the
 * turn had already ended.
 */
async function finishTurnInTransaction(
  db: AppDatabase,
  row: TurnRow,
  chunks: Chunks,
  status: 'cancelled' | 'failed',
  errorText: string,
  code?: ChatFailureCode,
): Promise<WaldenUIMessageChunk[] | null> {
  const now = nowIso();
  const partial = settleInterrupted(await buildUIMessage(row.id, chunks), now);
  const results = await failureStatements(db, row, status, now, partial);
  return results[2]?.meta.changes === 1 ? failureChunks(row, chunks, errorText, code, now) : null;
}

/** Whether the owner's conversation still exists, is active, and has not expired. */
export async function isConversationLive(
  db: AppDatabase,
  ownerId: string,
  conversationId: string,
): Promise<boolean> {
  return Boolean(
    await first(
      db
        .prepare(
          "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND expires_at>? AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=conversations.owner_id AND owner.deletion_pending=0)",
        )
        .bind(conversationId, ownerId, nowIso()),
    ),
  );
}

export async function completeTurn(
  db: AppDatabase,
  row: TurnRow,
  chunks: Chunks,
): Promise<WaldenUIMessageChunk[] | null> {
  return db.transaction
    ? db.transaction(
        (connection) => completeTurnInTransaction(connection, row, chunks),
        [`owner:${row.owner_id}`],
      )
    : completeTurnInTransaction(db, row, chunks);
}
export async function finishTurn(
  db: AppDatabase,
  row: TurnRow,
  chunks: Chunks,
  status: 'cancelled' | 'failed',
  errorText: string,
  code?: ChatFailureCode,
): Promise<WaldenUIMessageChunk[] | null> {
  return db.transaction
    ? db.transaction(
        (connection) => finishTurnInTransaction(connection, row, chunks, status, errorText, code),
        [`owner:${row.owner_id}`],
      )
    : finishTurnInTransaction(db, row, chunks, status, errorText, code);
}
