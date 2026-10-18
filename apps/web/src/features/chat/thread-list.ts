import type { ConversationSummary } from '@walden/contracts';

export type ThreadGroup = { label: string; threads: ConversationSummary[] };
type RecencyBoundaries = {
  today: number;
  yesterday: number;
  week: number;
  month: number;
};

const RECENCY_LABELS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];

/** Case- and punctuation-insensitive so "30-year" matches a search for "30 year". */
const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function matchesSearch(query: string, ...texts: string[]): boolean {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length) return true;
  const content = normalise(texts.join(' '));
  return terms.every((term) => content.includes(term));
}

function recencyBoundaries(now: Date): RecencyBoundaries {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  return {
    today: today.getTime(),
    yesterday: today.getTime() - dayMs,
    week: today.getTime() - 7 * dayMs,
    month: today.getTime() - 30 * dayMs,
  };
}

function recencyBucket(timestamp: string, boundaries: RecencyBoundaries): number {
  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) return 4;
  if (value >= boundaries.today) return 0;
  if (value >= boundaries.yesterday) return 1;
  if (value >= boundaries.week) return 2;
  if (value >= boundaries.month) return 3;
  return 4;
}

/**
 * Group threads by recency the way a person thinks about them, rather than
 * presenting one long undifferentiated column. Threads arrive newest first and
 * that order is preserved within every group.
 */
export function groupThreads(
  threads: readonly ConversationSummary[],
  now: Date = new Date(),
): ThreadGroup[] {
  const boundaries = recencyBoundaries(now);
  const buckets: ThreadGroup[] = RECENCY_LABELS.map((label) => ({ label, threads: [] }));
  for (const thread of threads) {
    buckets[recencyBucket(thread.updatedAt, boundaries)]?.threads.push(thread);
  }
  return buckets.filter((bucket) => bucket.threads.length > 0);
}

/** Expiry follows user activity, independently of the latest assistant message. */
export function threadRetention(thread: ConversationSummary, now: Date = new Date()) {
  if (thread.expiresAt === null) return 'No expiry';
  const remaining = Date.parse(thread.expiresAt) - now.getTime();
  if (!Number.isFinite(remaining)) return 'Expiry unavailable';
  if (remaining <= 0) return thread.noteId ? 'History expired · Note kept' : 'Expired';
  if (remaining > 3 * 86_400_000) return null;
  const minutes = Math.ceil(remaining / 60_000);
  const amount =
    minutes < 60 ? minutes : minutes < 1440 ? Math.ceil(minutes / 60) : Math.ceil(minutes / 1440);
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  return `${thread.noteId ? 'Archives' : 'Expires'} in ${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

export function threadTimestamp(thread: ConversationSummary) {
  const value = thread.lastMessageAt ?? thread.updatedAt;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    value,
    text: date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    full: date.toLocaleString(),
  };
}

export function isRetainedNote(thread: ConversationSummary, now: Date) {
  return (
    Boolean(thread.noteId) &&
    thread.expiresAt !== null &&
    Date.parse(thread.expiresAt) <= now.getTime()
  );
}

export function sidebarGroups(threads: readonly ConversationSummary[], now: Date): ThreadGroup[] {
  const notes = threads
    .filter((thread) => isRetainedNote(thread, now))
    .sort(
      (a, b) =>
        Date.parse(b.noteUpdatedAt ?? b.updatedAt) - Date.parse(a.noteUpdatedAt ?? a.updatedAt),
    );
  return [
    ...groupThreads(
      threads.filter((thread) => !isRetainedNote(thread, now)),
      now,
    ),
    ...(notes.length ? [{ label: 'Notes', threads: notes }] : []),
  ];
}
