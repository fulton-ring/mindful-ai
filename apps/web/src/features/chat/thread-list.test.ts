import type { ConversationSummary } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { filterThreads, groupThreads } from './thread-list';

const now = new Date('2026-09-19T12:00:00.000Z');
const thread = (id: string, title: string, updatedAt: string): ConversationSummary => ({
  id,
  title,
  updatedAt,
  noteId: null,
  expiresAt: '2999-01-01T00:00:00.000Z',
});

describe('groupThreads', () => {
  it('buckets by recency and omits empty groups', () => {
    const groups = groupThreads(
      [
        thread('a', 'Today thread', '2026-09-19T09:00:00.000Z'),
        thread('b', 'Yesterday thread', '2026-09-18T09:00:00.000Z'),
        thread('c', 'Last week thread', '2026-09-15T09:00:00.000Z'),
        thread('d', 'Ancient thread', '2025-01-01T09:00:00.000Z'),
      ],
      now,
    );
    expect(groups.map((group) => group.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Older',
    ]);
  });

  it('preserves the newest-first order inside a group', () => {
    const groups = groupThreads(
      [
        thread('a', 'Newer', '2026-09-19T11:00:00.000Z'),
        thread('b', 'Older', '2026-09-19T08:00:00.000Z'),
      ],
      now,
    );
    expect(groups[0]?.threads.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('keeps a thread with an unusable timestamp visible', () => {
    const groups = groupThreads([thread('a', 'Broken', 'not-a-date')], now);
    expect(groups.flatMap((group) => group.threads).map((item) => item.id)).toEqual(['a']);
  });
});

describe('filterThreads', () => {
  const threads = [
    thread('a', 'How is the 30 year yield linked to savings accounts?', now.toISOString()),
    thread('b', 'Explain how a heat pump moves heat', now.toISOString()),
  ];

  it('returns everything for an empty query', () => {
    expect(filterThreads(threads, '   ')).toHaveLength(2);
  });

  it('matches across punctuation and case', () => {
    expect(filterThreads(threads, '30-YEAR').map((item) => item.id)).toEqual(['a']);
  });

  it('requires every term to match', () => {
    expect(filterThreads(threads, 'heat pump')).toHaveLength(1);
    expect(filterThreads(threads, 'heat yield')).toHaveLength(0);
  });
});
