import type { ConversationSummary } from '@walden/contracts';

export type ThreadGroup = { label: string; threads: ConversationSummary[] };

/** Case- and punctuation-insensitive so "30-year" matches a search for "30 year". */
const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function filterThreads(
  threads: readonly ConversationSummary[],
  query: string,
): ConversationSummary[] {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length) return [...threads];
  return threads.filter((thread) => {
    const title = normalise(thread.title || 'Untitled thread');
    return terms.every((term) => title.includes(term));
  });
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
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const startOfYesterday = startOfToday.getTime() - dayMs;
  const startOfWeek = startOfToday.getTime() - 7 * dayMs;
  const startOfMonth = startOfToday.getTime() - 30 * dayMs;

  const buckets: ThreadGroup[] = [
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'Previous 7 days', threads: [] },
    { label: 'Previous 30 days', threads: [] },
    { label: 'Older', threads: [] },
  ];
  for (const thread of threads) {
    const at = Date.parse(thread.updatedAt);
    // An unparseable timestamp should not hide the thread.
    const index = Number.isNaN(at)
      ? 4
      : at >= startOfToday.getTime()
        ? 0
        : at >= startOfYesterday
          ? 1
          : at >= startOfWeek
            ? 2
            : at >= startOfMonth
              ? 3
              : 4;
    buckets[index]!.threads.push(thread);
  }
  return buckets.filter((bucket) => bucket.threads.length > 0);
}

/** Expiry follows user activity, independently of the latest assistant message. */
export function threadRetention(thread: ConversationSummary, now: Date = new Date()) {
  const remaining = Date.parse(thread.expiresAt) - now.getTime();
  if (!Number.isFinite(remaining)) return 'Expiry unavailable';
  if (remaining <= 0) return thread.noteId ? 'History expired · Note kept' : 'Expired';
  if (remaining > 3 * 86_400_000) return null;
  if (thread.noteId) return null;
  const minutes = Math.ceil(remaining / 60_000);
  const amount =
    minutes < 60 ? minutes : minutes < 1440 ? Math.ceil(minutes / 60) : Math.ceil(minutes / 1440);
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  return `Expires in ${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

export function threadTimestamp(thread: ConversationSummary) {
  const value = thread.lastMessageAt ?? thread.updatedAt;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    value,
    label: thread.lastMessageAt ? 'Last message' : 'Last active',
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
  return Boolean(thread.noteId) && Date.parse(thread.expiresAt) <= now.getTime();
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
