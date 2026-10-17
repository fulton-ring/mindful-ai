import type { MessageBudget } from '@walden/contracts';
import { first } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import { prepareQuery } from '../../db/database';
import { HttpError } from '../../http';
import type { Bindings } from '../../types';

/**
 * An anchored budget: an account's first message opens a window of
 * `windowHours`, messages spend their model's weight from `limit`, and the
 * whole budget comes back when the window ends.
 */
export type MessageLimit = { limit: number; windowHours: number };

const DEFAULT_LIMIT: MessageLimit = { limit: 20, windowHours: 4 };

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const messageLimitFrom = (
  env: Pick<Bindings, 'MESSAGE_LIMIT' | 'MESSAGE_WINDOW_HOURS'>,
): MessageLimit => ({
  limit: Math.floor(positive(env.MESSAGE_LIMIT, DEFAULT_LIMIT.limit)),
  windowHours: positive(env.MESSAGE_WINDOW_HOURS, DEFAULT_LIMIT.windowHours),
});

const windowMs = ({ windowHours }: MessageLimit) => windowHours * 60 * 60 * 1000;

type WindowRow = { started_at: string; used: number };

const loadWindow = (db: AppDatabase, ownerId: string) =>
  first<WindowRow>(
    db.prepare('SELECT started_at,used FROM message_windows WHERE owner_id=?').bind(ownerId),
  );

function waitText(ms: number) {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'in about a minute';
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `in ${hours}h${rest ? ` ${rest}m` : ''}`;
}

/**
 * Spends `weight` in one statement: an ended (or missing) window restarts at
 * `now`, and an open one only accepts the message if it stays within the limit.
 * Returns the window start so a failed admission can refund the charge.
 */
export async function chargeMessage(
  db: AppDatabase,
  ownerId: string,
  limit: MessageLimit,
  weight: number,
  now = Date.now(),
): Promise<string> {
  const startedAt = new Date(now).toISOString();
  const expiredBefore = new Date(now - windowMs(limit)).toISOString();
  const result =
    weight <= limit.limit
      ? await prepareQuery(db, {
          sqlite: `INSERT INTO message_windows (owner_id,started_at,used) VALUES (?,?,?)
       ON CONFLICT(owner_id) DO UPDATE SET
         started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END,
         used=CASE WHEN started_at<=? THEN excluded.used ELSE used+excluded.used END
       WHERE started_at<=? OR used+excluded.used<=?`,
          postgres: `INSERT INTO message_windows (owner_id,started_at,used) VALUES (?,?,?)
       ON CONFLICT(owner_id) DO UPDATE SET
         started_at=CASE WHEN message_windows.started_at<=? THEN excluded.started_at ELSE message_windows.started_at END,
         used=CASE WHEN message_windows.started_at<=? THEN excluded.used ELSE message_windows.used+excluded.used END
       WHERE message_windows.started_at<=? OR message_windows.used+excluded.used<=?`,
        })
          .bind(
            ownerId,
            startedAt,
            weight,
            expiredBefore,
            expiredBefore,
            expiredBefore,
            limit.limit,
          )
          .run()
      : null;
  const window = await loadWindow(db, ownerId);
  if ((result?.meta.changes ?? 0) > 0 && window) return window.started_at;
  const previousReset = window ? Date.parse(window.started_at) + windowMs(limit) : 0;
  const resetsAt = previousReset > now ? previousReset : now + windowMs(limit);
  throw new HttpError(
    429,
    `You've reached your message limit. It resets ${waitText(resetsAt - now)}.`,
    { code: 'message_limit', retryAt: new Date(resetsAt).toISOString(), weight },
  );
}

/** Returns a charge when the turn it paid for was never admitted. */
export async function refundMessage(
  db: AppDatabase,
  ownerId: string,
  startedAt: string,
  weight: number,
) {
  await prepareQuery(db, {
    sqlite: 'UPDATE message_windows SET used=MAX(used-?,0) WHERE owner_id=? AND started_at=?',
    postgres:
      'UPDATE message_windows SET used=GREATEST(used-?,0) WHERE owner_id=? AND started_at=?',
  })
    .bind(weight, ownerId, startedAt)
    .run();
}

/** Current budget for display. An ended window reads as a full budget. */
export async function loadMessageBudget(
  db: AppDatabase,
  ownerId: string,
  limit: MessageLimit,
  now = Date.now(),
): Promise<MessageBudget> {
  const window = await loadWindow(db, ownerId);
  const resetsAt = window ? Date.parse(window.started_at) + windowMs(limit) : 0;
  const open = window !== null && resetsAt > now;
  return {
    used: open ? window.used : 0,
    limit: limit.limit,
    windowHours: limit.windowHours,
    resetsAt: open ? new Date(resetsAt).toISOString() : null,
  };
}

/**
 * Analytics for the limit: how far into the window the account is, and how the
 * window was spent. `ms_since_window_start` on reaching the limit is how long it
 * took to use the whole budget.
 */
export async function limitWindowStats(
  db: AppDatabase,
  ownerId: string,
  budget: MessageBudget,
  now = Date.now(),
) {
  const resetsAt = budget.resetsAt ? Date.parse(budget.resetsAt) : now;
  const startedAt = resetsAt - budget.windowHours * 60 * 60 * 1000;
  const turns = await first<{ total: number }>(
    db
      .prepare('SELECT COUNT(*) AS total FROM turns WHERE owner_id=? AND created_at>=?')
      .bind(ownerId, new Date(startedAt).toISOString()),
  );
  return {
    used: budget.used,
    limit: budget.limit,
    window_hours: budget.windowHours,
    ms_since_window_start: Math.max(0, now - startedAt),
    ms_until_reset: Math.max(0, resetsAt - now),
    turns_in_window: turns?.total ?? 0,
  };
}
