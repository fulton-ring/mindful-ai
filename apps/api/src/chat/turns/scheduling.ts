import { all } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import type { Bindings } from '../../types';
import { turnObject } from './turn-session';
import { finishTurn, type TurnRow } from './turn-store';

const DAY_MS = 24 * 60 * 60_000;

/** Cancellation markers only need to outlive any request that could still race them. */
async function pruneCancellations(db: AppDatabase) {
  const week = new Date(Date.now() - 7 * DAY_MS).toISOString();
  await db.batch([
    db.prepare('DELETE FROM turn_cancellations WHERE created_at<?').bind(week),
    db.prepare('DELETE FROM note_suggestion_cancellations WHERE created_at<?').bind(week),
  ]);
}

/**
 * Settles turns that admission left behind: one without input never finished
 * admission, and one with input is started in its object (a no-op if it runs,
 * and a lost run is sealed as interrupted there).
 */
export async function reconcileTurns(env: Bindings) {
  await pruneCancellations(env.DB);
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const stale = await all<TurnRow>(
    env.DB.prepare(
      "SELECT * FROM turns WHERE status='streaming' AND created_at<? ORDER BY created_at LIMIT 100",
    ).bind(minuteAgo),
  );
  await Promise.all(
    stale.map(async (row) => {
      try {
        if (row.input_json) await turnObject(env, row.id).start(row.id);
        else
          await finishTurn(
            env.DB,
            row,
            [],
            'failed',
            'The response could not start. Please try again.',
          );
      } catch {
        console.warn('Turn reconciliation deferred', { turnId: row.id });
      }
    }),
  );
}
