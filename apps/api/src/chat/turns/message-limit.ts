import type { MessageBudget } from '@walden/contracts';
import { all, first } from '../../db/client';
import { HttpError } from '../../http';
import type { Bindings } from '../../types';

/** A sliding budget: the weights of the owner's turns in the window may not exceed `limit`. */
export type MessageLimit = { limit: number; windowHours: number };
export type MessageUsage = { used: number; since: string; windowMs: number };

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

/**
 * Every send, regenerate, and edit is a model call, so each admitted turn
 * counts with its model's weight. Turns of deleted threads drop out.
 */
export async function loadMessageUsage(
  db: D1Database,
  ownerId: string,
  { windowHours }: MessageLimit,
  now = Date.now(),
): Promise<MessageUsage> {
  const windowMs = windowHours * 60 * 60 * 1000;
  const since = new Date(now - windowMs).toISOString();
  const row = await first<{ used: number }>(
    db
      .prepare(
        'SELECT COALESCE(SUM(weight),0) AS used FROM turns WHERE owner_id=? AND created_at>?',
      )
      .bind(ownerId, since),
  );
  return { used: row?.used ?? 0, since, windowMs };
}

/** Current budget for display: how much is used and when points return. */
export async function loadMessageBudget(
  db: D1Database,
  ownerId: string,
  limit: MessageLimit,
  now = Date.now(),
): Promise<MessageBudget> {
  const windowMs = limit.windowHours * 60 * 60 * 1000;
  const row = await first<{ used: number; oldest: string | null; newest: string | null }>(
    db
      .prepare(
        'SELECT COALESCE(SUM(weight),0) AS used,MIN(created_at) AS oldest,MAX(created_at) AS newest FROM turns WHERE owner_id=? AND created_at>?',
      )
      .bind(ownerId, new Date(now - windowMs).toISOString()),
  );
  const after = (at: string | null | undefined) =>
    at ? new Date(Date.parse(at) + windowMs).toISOString() : null;
  return {
    used: row?.used ?? 0,
    limit: limit.limit,
    windowHours: limit.windowHours,
    nextResetAt: after(row?.oldest),
    fullResetAt: after(row?.newest),
  };
}

function waitText(ms: number) {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'in about a minute';
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `in ${hours}h${rest ? ` ${rest}m` : ''}`;
}

export async function assertWithinMessageLimit(
  db: D1Database,
  ownerId: string,
  { limit, windowHours }: MessageLimit,
  usage: MessageUsage,
  weight: number,
  now = Date.now(),
) {
  if (usage.used + weight <= limit) return;
  // Room reopens once enough of the oldest turns age out of the window.
  const turns = await all<{ created_at: string; weight: number }>(
    db
      .prepare(
        'SELECT created_at,weight FROM turns WHERE owner_id=? AND created_at>? ORDER BY created_at',
      )
      .bind(ownerId, usage.since),
  );
  let remaining = usage.used;
  let retryAt = now + usage.windowMs;
  for (const turn of turns) {
    remaining -= turn.weight;
    if (remaining + weight <= limit) {
      retryAt = Date.parse(turn.created_at) + usage.windowMs;
      break;
    }
  }
  const window = windowHours === 1 ? 'hour' : `${windowHours} hours`;
  throw new HttpError(
    429,
    `You've reached your message limit for the last ${window}. You can send another message ${waitText(retryAt - now)}.`,
    { code: 'message_limit', retryAt: new Date(retryAt).toISOString() },
  );
}
