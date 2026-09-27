import {
  type ChatFailureCode,
  type Intervention,
  uiMessageText,
  type WaldenUIMessage,
  type WaldenUIMessageChunk,
} from '@walden/contracts';
import { withoutQuizText } from '../../agent/learning-checks';
import { all, first } from '../../db/client';
import { nowIso } from '../../http';
import type { AgentTurnInput } from '../../services/types';
import { agentHighlightStatements } from '../highlights/agent-highlights';
import { buildUIMessage, metadataPatch, settleInterrupted, storedMessageJson } from '../messages';

export const TURN_BUDGET_MS = 15 * 60_000;

export type DurableTurnRow = {
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
  execution_epoch: number;
};
export type DurableTurnInput = AgentTurnInput & { userMessageId: string; forked: boolean };
export type StoredChunk = { seq: number; chunk: WaldenUIMessageChunk };
type TurnRef = Pick<DurableTurnRow, 'id' | 'conversation_id' | 'branch_id'>;

/** Writes are fenced to the live execution epoch of a still-streaming turn. */
const EPOCH_FENCE =
  "EXISTS(SELECT 1 FROM turns WHERE id=?1 AND execution_epoch=?2 AND status='streaming')";

/** First chunk of a restarted stream; delivered only to readers that saw the discarded one. */
export const resetChunk = (turn: TurnRef): WaldenUIMessageChunk => ({
  type: 'data-turn',
  data: { conversationId: turn.conversation_id, branchId: turn.branch_id, reset: true },
  transient: true,
});

export const isResetChunk = (chunk: WaldenUIMessageChunk) =>
  chunk.type === 'data-turn' && chunk.data.reset === true;

/** One statement per batch of chunks; `fence` binds ?1 (turn id) and then `fenceValues`. */
function insertChunks(
  db: D1Database,
  turnId: string,
  chunks: readonly WaldenUIMessageChunk[],
  fence: string,
  ...fenceValues: unknown[]
) {
  return db
    .prepare(
      `INSERT INTO turn_events(turn_id,chunk_json) SELECT ?1,j.value FROM json_each(?${fenceValues.length + 2}) j WHERE ${fence} ORDER BY j.key`,
    )
    .bind(turnId, ...fenceValues, JSON.stringify(chunks));
}

export async function appendTurnChunks(
  db: D1Database,
  turnId: string,
  epoch: number,
  chunks: readonly WaldenUIMessageChunk[],
) {
  if (!chunks.length) return;
  await insertChunks(db, turnId, chunks, EPOCH_FENCE, epoch).run();
}

/**
 * Replaces the epoch's stream with `kept`, so a replay from seq 0 is a single
 * well-formed attempt. With `reset`, readers that saw the discarded chunks get
 * a reset marker first.
 */
export async function restartTurnChunks(
  db: D1Database,
  turn: TurnRef,
  epoch: number,
  kept: readonly WaldenUIMessageChunk[],
  reset = true,
) {
  await db.batch([
    db.prepare(`DELETE FROM turn_events WHERE turn_id=?1 AND ${EPOCH_FENCE}`).bind(turn.id, epoch),
    insertChunks(db, turn.id, [...(reset ? [resetChunk(turn)] : []), ...kept], EPOCH_FENCE, epoch),
  ]);
}

export async function beginTurnExecution(db: D1Database, turn: TurnRef): Promise<number | null> {
  const row = await first<{ execution_epoch: number }>(
    db
      .prepare(
        "UPDATE turns SET execution_epoch=execution_epoch+1 WHERE id=? AND status='streaming' RETURNING execution_epoch",
      )
      .bind(turn.id),
  );
  if (!row) return null;
  if (row.execution_epoch > 1) await restartTurnChunks(db, turn, row.execution_epoch, []);
  return row.execution_epoch;
}

export async function readTurnChunks(
  db: D1Database,
  turnId: string,
  after = 0,
  limit = 256,
): Promise<StoredChunk[]> {
  const rows = await all<{ seq: number; chunk_json: string }>(
    db
      .prepare(
        'SELECT seq,chunk_json FROM turn_events WHERE turn_id=? AND seq>? ORDER BY seq LIMIT ?',
      )
      .bind(turnId, after, limit),
  );
  return rows.map(({ seq, chunk_json }) => ({
    seq,
    chunk: JSON.parse(chunk_json) as WaldenUIMessageChunk,
  }));
}

async function allTurnChunks(db: D1Database, turnId: string) {
  const chunks: WaldenUIMessageChunk[] = [];
  for (let after = 0; ; ) {
    const page = await readTurnChunks(db, turnId, after, 1000);
    chunks.push(...page.map(({ chunk }) => chunk));
    if (page.length < 1000) return chunks;
    after = page.at(-1)!.seq;
  }
}

function interventionOf(message: WaldenUIMessage): Intervention | undefined {
  for (const part of message.parts) if (part.type === 'data-intervention') return part.data;
  return undefined;
}

const ACTIVE = `SELECT 1 FROM turns t JOIN conversations c ON c.id=t.conversation_id
    JOIN conversation_branches b ON b.id=t.branch_id
    WHERE t.id=?1 AND t.execution_epoch=?2 AND t.status='streaming'
    AND c.status='active' AND b.status='active' AND c.expires_at>?3`;
const COMPLETED_MESSAGE =
  "EXISTS(SELECT 1 FROM messages WHERE id=?1 AND json_extract(ui_message,'$.metadata.status')='complete')";

function interventionStatements(
  db: D1Database,
  row: DurableTurnRow,
  epoch: number,
  now: string,
  intervention: Intervention | undefined,
): D1PreparedStatement[] {
  if (!intervention) return [];
  return [
    db
      .prepare(
        `UPDATE interventions SET status='superseded' WHERE branch_id=?4 AND owner_id=?5 AND status='pending' AND EXISTS (${ACTIVE})`,
      )
      .bind(row.id, epoch, now, row.branch_id, row.owner_id),
    db
      .prepare(`INSERT OR IGNORE INTO interventions(id,conversation_id,turn_id,owner_id,kind,payload_json,status,created_at,branch_id)
        SELECT ?4,?5,?1,?6,?7,?8,'pending',?3,?9 WHERE EXISTS (${ACTIVE})`)
      .bind(
        row.id,
        epoch,
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

function completionChunks(row: DurableTurnRow): WaldenUIMessageChunk[] {
  const input = JSON.parse(row.input_json ?? '{}') as Partial<DurableTurnInput>;
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
  db: D1Database,
  row: DurableTurnRow,
  epoch: number,
  now: string,
  message: WaldenUIMessage,
) {
  return [
    db
      .prepare(`INSERT OR IGNORE INTO messages
      (id,conversation_id,turn_id,owner_id,role,created_at,parent_message_id,origin_branch_id,ui_message)
      SELECT ?1,?4,?1,?5,'assistant',?3,?6,?7,?8 WHERE EXISTS (${ACTIVE})`)
      .bind(
        row.id,
        epoch,
        now,
        row.conversation_id,
        row.owner_id,
        row.user_message_id,
        row.branch_id,
        storedMessageJson(message),
      ),
    insertChunks(
      db,
      row.id,
      completionChunks(row),
      `EXISTS (${ACTIVE}) AND ${COMPLETED_MESSAGE}`,
      epoch,
      now,
    ),
    ...interventionStatements(db, row, epoch, now, interventionOf(message)),
    db
      .prepare(
        `UPDATE conversation_branches SET head_message_id=?1 WHERE id=?4 AND EXISTS (${ACTIVE}) AND ${COMPLETED_MESSAGE}`,
      )
      .bind(row.id, epoch, now, row.branch_id),
    db
      .prepare(`UPDATE turns SET status='completed',completed_at=?3,input_json=NULL
      WHERE id=?1 AND execution_epoch=?2 AND status='streaming' AND ${COMPLETED_MESSAGE}`)
      .bind(row.id, epoch, now),
  ];
}

/** Commits the epoch's streamed reply as the branch's new head, exactly once. */
export async function completeTurn(db: D1Database, turnId: string, epoch: number) {
  const row = await first<DurableTurnRow>(
    db.prepare('SELECT * FROM turns WHERE id=?').bind(turnId),
  );
  if (!row || row.status !== 'streaming' || row.execution_epoch !== epoch) return false;
  const built = withoutQuizText(await buildUIMessage(turnId, await allTurnChunks(db, turnId)));
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
    ...completionStatements(db, row, epoch, now, message),
    ...agentHighlightStatements(db, {
      messageId: turnId,
      ownerId: row.owner_id,
      content: uiMessageText(message),
      annotations: [],
      updatedAt: now,
      completedTurnEpoch: epoch,
    }),
  ]);
  const committed = await first<{ status: string; execution_epoch: number }>(
    db.prepare('SELECT status,execution_epoch FROM turns WHERE id=?').bind(turnId),
  );
  return committed?.status === 'completed' && committed.execution_epoch === epoch;
}

function failureChunks(
  row: DurableTurnRow,
  chunks: readonly WaldenUIMessageChunk[],
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
  db: D1Database,
  row: DurableTurnRow,
  status: 'cancelled' | 'failed',
  fence: string,
  now: string,
  terminal: WaldenUIMessageChunk[],
  partial: WaldenUIMessage,
) {
  const streaming = `EXISTS(SELECT 1 FROM turns WHERE id=?1 AND status='streaming'${fence})`;
  return db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO messages(id,conversation_id,turn_id,owner_id,role,created_at,parent_message_id,origin_branch_id,ui_message)
      SELECT ?1,?2,?1,?3,'assistant',?4,?5,?6,?7 WHERE ${streaming}`)
      .bind(
        row.id,
        row.conversation_id,
        row.owner_id,
        now,
        row.user_message_id,
        row.branch_id,
        storedMessageJson(partial),
      ),
    insertChunks(db, row.id, terminal, streaming),
    db
      .prepare(`UPDATE conversation_branches SET head_message_id=?1 WHERE id=?2 AND ${streaming}`)
      .bind(row.id, row.branch_id),
    db
      .prepare(
        `UPDATE turns SET status=?2,completed_at=?3,input_json=NULL WHERE id=?1 AND owner_id=?4 AND status='streaming'${fence}`,
      )
      .bind(row.id, status, now, row.owner_id),
    db
      .prepare(
        `UPDATE interventions SET status='invalidated' WHERE turn_id=?1 AND status='pending' AND EXISTS(SELECT 1 FROM turns WHERE id=?1 AND status IN ('failed','cancelled') AND completed_at=?2)`,
      )
      .bind(row.id, now),
  ]);
}

/**
 * Ends a streaming turn early. The reply streamed so far is kept as an
 * interrupted message, and the stream ends with an error.
 */
export async function finishTurn(
  db: D1Database,
  turnId: string,
  ownerId: string,
  status: 'cancelled' | 'failed',
  message: string,
  expectedEpoch?: number,
  code?: ChatFailureCode,
) {
  const fence =
    expectedEpoch === undefined ? '' : ` AND execution_epoch=${Math.trunc(expectedEpoch)}`;
  const row = await first<DurableTurnRow>(
    db
      .prepare(`SELECT * FROM turns WHERE id=? AND owner_id=? AND status='streaming'${fence}`)
      .bind(turnId, ownerId),
  );
  if (!row) return false;
  const chunks = await allTurnChunks(db, turnId);
  const now = nowIso();
  const partial = settleInterrupted(await buildUIMessage(turnId, chunks), now);
  const terminal = failureChunks(row, chunks, message, code, now);
  const results = await failureStatements(db, row, status, fence, now, terminal, partial);
  return results[3]?.meta.changes === 1;
}

export const cancelTurn = (db: D1Database, turnId: string, ownerId: string) =>
  finishTurn(db, turnId, ownerId, 'cancelled', 'Turn cancelled', undefined, 'cancelled');

/** Whether the owner's conversation still exists, is active, and has not expired. */
export async function isConversationLive(
  db: D1Database,
  ownerId: string,
  conversationId: string,
): Promise<boolean> {
  return Boolean(
    await first(
      db
        .prepare(
          "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND expires_at>?",
        )
        .bind(conversationId, ownerId, nowIso()),
    ),
  );
}
