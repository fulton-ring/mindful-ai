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
