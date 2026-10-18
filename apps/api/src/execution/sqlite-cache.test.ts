import { describe, expect, it } from 'vitest';
import { sqliteStorage } from './do-workflows-test-helper';
import { DoSqliteCache } from './sqlite-cache';

describe('persistent Mastra SQLite cache', () => {
  it('preserves values and streams across cache restart and expires persisted TTL', async () => {
    const storage = sqliteStorage();
    const cache = new DoSqliteCache({ storage, ttlMs: 0 });
    await cache.set('object', { answer: 42 });
    await cache.listPush('events', { value: 'first' });
    await cache.listPush('events', { value: 'second' });
    const restarted = new DoSqliteCache({ storage, ttlMs: 0 });
    expect(await restarted.get('object')).toEqual({ answer: 42 });
    expect(await restarted.listLength('events')).toBe(2);
    expect(await restarted.listFromTo('events', 0, 0)).toEqual([{ value: 'first' }]);
    expect(await restarted.listFromTo('events', -1)).toEqual([{ value: 'second' }]);
    await cache.set('expired', 7, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await restarted.get('expired')).toBeUndefined();
    await restarted.delete('events');
    expect(await cache.listLength('events')).toBe(0);
    await restarted.clear();
    expect(await cache.get('object')).toBeUndefined();
  });

  it('allocates ordered indices and appends atomically, rolling counters back on invalid lists', async () => {
    const cache = new DoSqliteCache({ storage: sqliteStorage(), ttlMs: 0 });
    expect(
      await Promise.all(
        Array.from({ length: 40 }, (_, n) => cache.listPushIndexed('events', 'counter', { n })),
      ),
    ).toEqual(Array.from({ length: 40 }, (_, i) => i));
    const events = (await cache.listFromTo('events', 0)) as Array<{ index: number }>;
    expect(events.map((event) => event.index)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    await cache.set('invalid', {});
    await expect(cache.listPushIndexed('invalid', 'counter', {})).rejects.toThrow();
    expect(await cache.increment('counter')).toBe(41);
    await cache.set('invalid-counter', 'string');
    await expect(cache.increment('invalid-counter')).rejects.toThrow();
  });
});

it('preserves JSON types in streams and replaces expired keys after a TTL-free restart', async () => {
  const storage = sqliteStorage();
  const cache = new DoSqliteCache({ storage, ttlMs: 0 });
  const values = [true, false, 'hello', 3, null, { nested: [true, 'hello'] }, ['array']];
  for (const value of values) await cache.listPush('typed', value);
  expect(await cache.listFromTo('typed', 0)).toEqual(values);
  await cache.set('old', ['expired'], 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cache.listPush('old', 'new');
  expect(await cache.listFromTo('old', 0)).toEqual(['new']);
});

it('prunes expired persisted keys while retaining streams with disabled TTL', async () => {
  const storage = sqliteStorage();
  const cache = new DoSqliteCache({ storage, ttlMs: 0 });
  await cache.set('expired', 1, 1);
  await cache.listPush('retained', 'event');
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await cache.prune()).toBe(1);
  expect(await cache.prune()).toBe(0);
  expect(await cache.listFromTo('retained', 0)).toEqual(['event']);
});
