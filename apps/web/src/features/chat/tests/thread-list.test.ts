import type { ConversationSummary, Note } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import {
  groupThreads,
  matchesSearch,
  sidebarGroups,
  threadRetention,
  threadTimestamp,
} from '../thread-list';

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

describe('matchesSearch', () => {
  it('returns everything for an empty query', () => {
    expect(matchesSearch('   ', 'Any note')).toBe(true);
  });

  it('matches across punctuation and case', () => {
    expect(matchesSearch('30-YEAR', 'How is the 30 year yield?')).toBe(true);
  });

  it('matches note body text and requires every term', () => {
    const note = { title: 'Botany', markdown: 'The stroma contains enzymes.' } satisfies Pick<
      Note,
      'title' | 'markdown'
    >;
    expect(matchesSearch('botany enzymes', note.title, note.markdown)).toBe(true);
    expect(matchesSearch('botany mitochondria', note.title, note.markdown)).toBe(false);
  });
});

describe('thread metadata', () => {
  const item = {
    ...thread('a', 'Thread', now.toISOString()),
    expiresAt: '2026-09-21T12:00:00.000Z',
  };
  it('distinguishes permanent deletion from clearing history and retaining a note', () => {
    expect(threadRetention(item, now)).toBe('Expires in 2 days');
    expect(threadRetention({ ...item, noteId: 'note' }, now)).toBe('Archives in 2 days');
  });
  it('only warns within three days of expiry', () => {
    expect(threadRetention({ ...item, expiresAt: '2026-09-22T12:00:00.001Z' }, now)).toBeNull();
    expect(threadRetention({ ...item, expiresAt: '2026-09-22T12:00:00.000Z' }, now)).toBe(
      'Expires in 3 days',
    );
  });
  it('shows hours near expiry and handles already expired threads', () => {
    expect(threadRetention(item, new Date('2026-09-21T11:30:00Z'))).toBe('Expires in 30 minutes');
    expect(threadRetention(item, new Date(item.expiresAt))).toBe('Expired');
    expect(threadRetention({ ...item, noteId: 'note' }, new Date(item.expiresAt))).toBe(
      'History expired · Note kept',
    );
  });
  it('uses the last actual message time without changing the expiry time', () => {
    const latest = '2026-09-19T12:02:00.000Z';
    expect(threadTimestamp({ ...item, lastMessageAt: latest })).toMatchObject({
      value: latest,
      text: expect.any(String),
    });
    expect(threadTimestamp(item)).toMatchObject({ value: item.updatedAt });
    expect(threadTimestamp(item)).not.toHaveProperty('label');
    expect(threadTimestamp({ ...item, updatedAt: 'invalid' })).toBeNull();
  });
});

it('separates retained notes and sorts them by edit time', () => {
  const base = thread('live', 'Live', now.toISOString());
  const older = {
    ...base,
    id: 'older',
    noteId: 'a',
    expiresAt: '2020-01-01',
    noteUpdatedAt: '2026-09-17',
  };
  const newer = { ...older, id: 'newer', noteId: 'b', noteUpdatedAt: '2026-09-18' };
  const groups = sidebarGroups([older, base, newer], now);
  expect(groups.map(({ label }) => label)).toEqual(['Today', 'Notes']);
  expect(groups[1]?.threads.map(({ id }) => id)).toEqual(['newer', 'older']);
});
