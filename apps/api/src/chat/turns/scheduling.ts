import { all } from '../../db/client';
import type { Bindings } from '../../types';
import { type DurableTurnRow, finishTurn, TURN_BUDGET_MS } from './durable-store';

export async function ensureTurnScheduled(env: Bindings, row: DurableTurnRow) {
  if (!env.CHAT_WORKFLOW || row.status !== 'streaming' || !row.input_json) return;
  if (Date.now() - Date.parse(row.created_at) > TURN_BUDGET_MS) {
    await finishTurn(
      env.DB,
      row.id,
      row.owner_id,
      'failed',
      'This turn exceeded its 15-minute execution budget. Please try again.',
    );
    await (await env.CHAT_WORKFLOW.get(row.id)).terminate().catch(() => undefined);
    return;
  }
  try {
    await env.CHAT_WORKFLOW.create({
      id: row.id,
      params: { turnId: row.id },
      retention: { successRetention: '5 minutes', errorRetention: '5 minutes' },
    });
  } catch (creationError) {
    // Only an existing instance can turn a create failure into success. Auth,
    // capacity, or network failures leave the transactional outbox for retry.
    let status: InstanceStatus;
    try {
      status = await (await env.CHAT_WORKFLOW.get(row.id)).status();
    } catch {
      throw creationError;
    }
    if (
      status.status === 'errored' ||
      status.status === 'terminated' ||
      status.status === 'complete'
    )
      await finishTurn(
        env.DB,
        row.id,
        row.owner_id,
        'failed',
        'The response could not finish. Please try again.',
      );
  }
}

const DAY_MS = 24 * 60 * 60_000;

/** Cancellation markers only need to outlive any request that could still race them. */
async function pruneTurnState(db: D1Database) {
  const week = new Date(Date.now() - 7 * DAY_MS).toISOString();
  // Clients replay events only while a turn is live or just finished; the
  // completed transcript lives in messages.
  const day = new Date(Date.now() - DAY_MS).toISOString();
  await db.batch([
    db.prepare('DELETE FROM turn_cancellations WHERE created_at<?').bind(week),
    db.prepare('DELETE FROM note_suggestion_cancellations WHERE created_at<?').bind(week),
    db
      .prepare(
        "DELETE FROM turn_events WHERE turn_id IN (SELECT id FROM turns WHERE status<>'streaming' AND completed_at<?)",
      )
      .bind(day),
  ]);
}

export async function reconcileTurns(env: Bindings) {
  await pruneTurnState(env.DB);
  const abandoned = await all<DurableTurnRow>(
    env.DB.prepare(
      "SELECT * FROM turns WHERE status='streaming' AND input_json IS NULL AND created_at<? LIMIT 100",
    ).bind(new Date(Date.now() - 60_000).toISOString()),
  );
  await Promise.all(
    abandoned.map((row) =>
      finishTurn(
        env.DB,
        row.id,
        row.owner_id,
        'failed',
        'The response could not start. Please try again.',
      ),
    ),
  );
  let after = '';
  for (;;) {
    const rows = await all<DurableTurnRow>(
      env.DB.prepare(
        "SELECT * FROM turns WHERE status='streaming' AND input_json IS NOT NULL AND id>? ORDER BY id LIMIT 100",
      ).bind(after),
    );
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 10) {
      await Promise.all(
        rows.slice(i, i + 10).map(async (row) => {
          try {
            await ensureTurnScheduled(env, row);
          } catch {
            console.warn('Turn reconciliation deferred', { turnId: row.id });
          }
        }),
      );
    }
    after = rows.at(-1)!.id;
  }
}
