import type {
  ChatEvent,
  ChatFailureCode,
  Message,
  MessageSource,
  ToolActivity,
} from '@walden/contracts';
import { all, first } from '../../db/client';
import { nowIso } from '../../http';
import type { AgentTurnInput } from '../../services/types';
import { agentHighlightStatements } from '../highlights/agent-highlights';

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

export async function beginTurnExecution(db: D1Database, turnId: string): Promise<number | null> {
  const row = await first<{ execution_epoch: number }>(
    db
      .prepare(
        "UPDATE turns SET execution_epoch=execution_epoch+1 WHERE id=? AND status='streaming' RETURNING execution_epoch",
      )
      .bind(turnId),
  );
  if (!row) return null;
  await appendTurnEvents(db, turnId, row.execution_epoch, [{ type: 'reset' }]);
  return row.execution_epoch;
}

export async function appendTurnEvents(
  db: D1Database,
  turnId: string,
  epoch: number,
  events: ChatEvent[],
) {
  if (!events.length) return;
  await db.batch(
    events.map((event) =>
      db
        .prepare(
          "INSERT INTO turn_events(turn_id,event_json) SELECT id,? FROM turns WHERE id=? AND execution_epoch=? AND status='streaming'",
        )
        .bind(JSON.stringify(event), turnId, epoch),
    ),
  );
}

export async function readTurnEvents(db: D1Database, turnId: string, after: number) {
  const rows = await all<{ seq: number; event_json: string }>(
    db
      .prepare(
        'SELECT seq,event_json FROM turn_events WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 256',
      )
      .bind(turnId, after),
  );
  return rows.map(({ seq, event_json }) => ({ seq, event: JSON.parse(event_json) as ChatEvent }));
}
function completedMessageStatement(
  db: D1Database,
  row: DurableTurnRow,
  turnId: string,
  epoch: number,
  now: string,
  message: Message,
  personaName: string | null,
  active: string,
) {
  return db
    .prepare(`INSERT OR IGNORE INTO messages
      (id,conversation_id,turn_id,owner_id,role,content,reasoning,activity_json,incomplete,created_at,parent_message_id,origin_branch_id,persona_name)
      SELECT ?,?,?,?,'assistant',?,?,?,0,?,?,?,?
      WHERE EXISTS (${active})`)
    .bind(
      turnId,
      row.conversation_id,
      turnId,
      row.owner_id,
      message.content,
      message.reasoning ?? null,
      JSON.stringify({
        tools: message.tools ?? [],
        sources: message.sources ?? [],
        contextCompacted: message.contextCompacted ?? false,
        ...(message.learningCheck ? { learningCheck: message.learningCheck } : {}),
      }),
      message.createdAt,
      row.user_message_id,
      row.branch_id,
      personaName,
      turnId,
      epoch,
      now,
    );
}

function interventionStatements(
  db: D1Database,
  row: DurableTurnRow,
  turnId: string,
  epoch: number,
  now: string,
  active: string,
  intervention: Extract<ChatEvent, { type: 'intervention' }>['intervention'] | undefined,
): D1PreparedStatement[] {
  return intervention
    ? [
        db
          .prepare(
            `UPDATE interventions SET status='superseded' WHERE branch_id=? AND owner_id=? AND status='pending' AND EXISTS (${active})`,
          )
          .bind(row.branch_id, row.owner_id, turnId, epoch, now),
        db
          .prepare(`INSERT OR IGNORE INTO interventions(id,conversation_id,turn_id,owner_id,kind,payload_json,status,created_at,branch_id)
        SELECT ?,?,?,?,?,?,'pending',?,? WHERE EXISTS (${active})`)
          .bind(
            intervention.id,
            row.conversation_id,
            turnId,
            row.owner_id,
            intervention.kind,
            JSON.stringify(intervention),
            now,
            row.branch_id,
            turnId,
            epoch,
            now,
          ),
      ]
    : [];
}

export async function completeTurn(
  db: D1Database,
  turnId: string,
  epoch: number,
  done: Extract<ChatEvent, { type: 'done' }>,
  intervention?: Extract<ChatEvent, { type: 'intervention' }>['intervention'],
) {
  const row = await first<DurableTurnRow>(
    db.prepare('SELECT * FROM turns WHERE id=?').bind(turnId),
  );
  if (!row || row.status !== 'streaming' || row.execution_epoch !== epoch) return false;
  const input = JSON.parse(row.input_json ?? '{}') as Partial<DurableTurnInput>;
  const message = { ...done.message, id: turnId };
  const terminal = { ...done, message, userMessageId: row.user_message_id ?? undefined };
  const active = `SELECT 1 FROM turns t JOIN conversations c ON c.id=t.conversation_id
    JOIN conversation_branches b ON b.id=t.branch_id
    WHERE t.id=? AND t.execution_epoch=? AND t.status='streaming'
    AND c.status='active' AND b.status='active' AND c.expires_at>?`;
  const now = nowIso();
  await db.batch([
    completedMessageStatement(
      db,
      row,
      turnId,
      epoch,
      now,
      message,
      input.persona?.name ?? null,
      active,
    ),
    db
      .prepare(`INSERT INTO turn_events(turn_id,event_json) SELECT ?,? WHERE EXISTS (${active})
      AND EXISTS(SELECT 1 FROM messages WHERE id=? AND incomplete=0)`)
      .bind(turnId, JSON.stringify(terminal), turnId, epoch, now, turnId),
    ...interventionStatements(db, row, turnId, epoch, now, active, intervention),
    db
      .prepare(`UPDATE conversation_branches SET head_message_id=? WHERE id=? AND EXISTS (${active})
      AND EXISTS(SELECT 1 FROM messages WHERE id=? AND incomplete=0)`)
      .bind(turnId, row.branch_id, turnId, epoch, now, turnId),
    db
      .prepare(`UPDATE turns SET status='completed',completed_at=?,input_json=NULL
      WHERE id=? AND execution_epoch=? AND status='streaming' AND EXISTS(SELECT 1 FROM messages WHERE id=? AND incomplete=0)`)
      .bind(now, turnId, epoch, turnId),
    ...agentHighlightStatements(db, {
      messageId: turnId,
      ownerId: row.owner_id,
      content: message.content,
      annotations: message.annotations ?? [],
      updatedAt: message.createdAt,
      completedTurnEpoch: epoch,
    }),
  ]);
  const committed = await first<{ status: string; execution_epoch: number }>(
    db.prepare('SELECT status,execution_epoch FROM turns WHERE id=?').bind(turnId),
  );
  return committed?.status === 'completed' && committed.execution_epoch === epoch;
}

function partialMessageFromEvents(
  turnId: string,
  events: { event_json: string }[],
  now: string,
): Message {
  let text = '';
  let reasoning = '';
  const tools = new Map<string, ToolActivity>();
  const sources = new Map<string, MessageSource>();
  let contextCompacted = false;
  for (const { event_json } of events) {
    const event = JSON.parse(event_json) as ChatEvent;
    if (event.type === 'text-snapshot') {
      text = event.text;
      reasoning = event.reasoning;
    }
    if (event.type === 'text') text += event.text;
    if (event.type === 'reasoning') reasoning += event.text;
    if (event.type === 'tool')
      tools.set(
        event.tool.id,
        event.tool.state === 'running'
          ? { ...event.tool, state: 'error', summary: 'Stopped' }
          : event.tool,
      );
    if (event.type === 'source') sources.set(event.source.url, event.source);
    if (event.type === 'context-compacted') contextCompacted = true;
  }
  return {
    id: turnId,
    role: 'assistant',
    content: text,
    ...(reasoning ? { reasoning } : {}),
    incomplete: true,
    tools: [...tools.values()],
    sources: [...sources.values()],
    contextCompacted,
    createdAt: now,
  };
}

function persistFailure(
  db: D1Database,
  row: DurableTurnRow,
  turnId: string,
  ownerId: string,
  status: 'cancelled' | 'failed',
  fence: string,
  now: string,
  error: ChatEvent,
  partialMessage: Message,
) {
  return db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO messages(id,conversation_id,turn_id,owner_id,role,content,reasoning,activity_json,incomplete,created_at,parent_message_id,origin_branch_id)
      SELECT ?,?,?,?,'assistant',?,?,?,1,?,?,?
      WHERE EXISTS(SELECT 1 FROM turns WHERE id=? AND status='streaming'${fence})`)
      .bind(
        turnId,
        row.conversation_id,
        turnId,
        ownerId,
        partialMessage.content,
        partialMessage.reasoning || null,
        JSON.stringify({
          tools: partialMessage.tools,
          sources: partialMessage.sources,
          contextCompacted: partialMessage.contextCompacted,
        }),
        now,
        row.user_message_id,
        row.branch_id,
        turnId,
      ),
    db
      .prepare(
        `INSERT INTO turn_events(turn_id,event_json) SELECT id,? FROM turns WHERE id=? AND status='streaming'${fence}`,
      )
      .bind(JSON.stringify(error), turnId),
    db
      .prepare(
        `UPDATE conversation_branches SET head_message_id=? WHERE id=? AND EXISTS(SELECT 1 FROM turns WHERE id=? AND status='streaming'${fence})`,
      )
      .bind(turnId, row.branch_id, turnId),
    db
      .prepare(
        `UPDATE turns SET status=?,completed_at=?,input_json=NULL WHERE id=? AND owner_id=? AND status='streaming'${fence}`,
      )
      .bind(status, now, turnId, ownerId),
    db
      .prepare(
        `UPDATE interventions SET status='invalidated' WHERE turn_id=? AND status='pending' AND EXISTS(SELECT 1 FROM turns WHERE id=? AND status IN ('failed','cancelled') AND completed_at=?)`,
      )
      .bind(turnId, turnId, now),
  ]);
}

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
  // Only progress since the most recent reset belongs to the current attempt.
  const events = await all<{ event_json: string }>(
    db
      .prepare(`SELECT event_json FROM turn_events WHERE turn_id=?
    AND seq>COALESCE((SELECT MAX(seq) FROM turn_events WHERE turn_id=? AND json_extract(event_json,'$.type')='reset'),0) ORDER BY seq`)
      .bind(turnId, turnId),
  );
  const now = nowIso();
  const partialMessage = partialMessageFromEvents(turnId, events, now);
  const error: ChatEvent = {
    type: 'error',
    message,
    code,
    partialMessage,
    branchId: row.branch_id,
    userMessageId: row.user_message_id ?? undefined,
  };
  const results = await persistFailure(
    db,
    row,
    turnId,
    ownerId,
    status,
    fence,
    now,
    error,
    partialMessage,
  );
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
