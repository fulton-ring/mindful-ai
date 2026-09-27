import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import {
  assertWithinMessageLimit,
  loadMessageBudget,
  loadMessageUsage,
  type MessageLimit,
  messageLimitFrom,
} from '../message-limit';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

async function fixture(turns: { hoursAgo: number; weight: number }[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-message-limit-')), 'db.sqlite');
  const migrations = new URL('../../../../migrations/', import.meta.url);
  execFileSync('sqlite3', [file], {
    input: readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n'),
  });
  const db = sqliteD1Binding(file);
  await db.prepare("INSERT INTO users VALUES ('owner','subject','now','now',0)").run();
  await db
    .prepare(
      "INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('chat','owner','Title','now','2999-01-01','active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,created_at) VALUES ('branch','chat','owner',1,'now')",
    )
    .run();
  for (const [index, turn] of turns.entries())
    await db
      .prepare(
        "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id,weight) VALUES (?,?,'chat','owner','completed',?,'branch','branch',?)",
      )
      .bind(
        `turn-${index}`,
        `request-${index}`,
        new Date(NOW - turn.hoursAgo * HOUR).toISOString(),
        turn.weight,
      )
      .run();
  return db;
}

async function check(db: D1Database, limit: MessageLimit, weight: number) {
  const usage = await loadMessageUsage(db, 'owner', limit, NOW);
  return assertWithinMessageLimit(db, 'owner', limit, usage, weight, NOW);
}

describe('sliding message limit', () => {
  const limit = { limit: 4, windowHours: 5 };

  it('sums model weights inside the window and ignores older turns', async () => {
    const db = await fixture([
      { hoursAgo: 6, weight: 3 },
      { hoursAgo: 4, weight: 1 },
      { hoursAgo: 1, weight: 2 },
    ]);
    expect((await loadMessageUsage(db, 'owner', limit, NOW)).used).toBe(3);
    await expect(check(db, limit, 1)).resolves.toBeUndefined();
  });

  it('rejects a message whose weight would exceed the budget, with the reopening time', async () => {
    const db = await fixture([
      { hoursAgo: 4, weight: 1 },
      { hoursAgo: 2, weight: 2 },
      { hoursAgo: 1, weight: 1 },
    ]);
    const error = await check(db, limit, 2).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, details: { code: 'message_limit' } });
    // Dropping the 4-hour-old turn frees only 1 of the 2 needed; the 2-hour-old one frees enough.
    expect((error as HttpError).details).toMatchObject({
      retryAt: new Date(NOW - 2 * HOUR + 5 * HOUR).toISOString(),
    });
    expect((error as HttpError).message).toContain('in 3h');
  });

  it('reports the budget with when points start and finish coming back', async () => {
    const db = await fixture([
      { hoursAgo: 6, weight: 3 },
      { hoursAgo: 4, weight: 1 },
      { hoursAgo: 1, weight: 2 },
    ]);
    expect(await loadMessageBudget(db, 'owner', limit, NOW)).toEqual({
      used: 3,
      limit: 4,
      windowHours: 5,
      nextResetAt: new Date(NOW + 1 * HOUR).toISOString(),
      fullResetAt: new Date(NOW + 4 * HOUR).toISOString(),
    });
    const empty = await fixture([]);
    expect(await loadMessageBudget(empty, 'owner', limit, NOW)).toMatchObject({
      used: 0,
      nextResetAt: null,
      fullResetAt: null,
    });
  });

  it('reads the budget from Worker vars with safe defaults', () => {
    expect(messageLimitFrom({})).toEqual({ limit: 20, windowHours: 4 });
    expect(messageLimitFrom({ MESSAGE_LIMIT: '8', MESSAGE_WINDOW_HOURS: '3' })).toEqual({
      limit: 8,
      windowHours: 3,
    });
    expect(messageLimitFrom({ MESSAGE_LIMIT: 'nope', MESSAGE_WINDOW_HOURS: '-1' })).toEqual({
      limit: 20,
      windowHours: 4,
    });
  });
});
