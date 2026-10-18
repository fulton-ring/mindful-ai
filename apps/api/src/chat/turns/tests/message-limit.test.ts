import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import {
  chargeMessage,
  loadMessageBudget,
  messageLimitFrom,
  refundMessage,
} from '../message-limit';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const limit = { limit: 4, windowHours: 4 };

async function fixture() {
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
  await db
    .prepare(
      "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('owner','subject','now','now',0)",
    )
    .run();
  return db;
}

const at = (hours: number) => NOW + hours * HOUR;

describe('anchored message limit', () => {
  it('opens a window with the first message and spends model weights from it', async () => {
    const db = await fixture();
    expect(await chargeMessage(db, 'owner', limit, 1, at(0))).toBe(new Date(at(0)).toISOString());
    await chargeMessage(db, 'owner', limit, 2, at(1));
    expect(await loadMessageBudget(db, 'owner', limit, at(2))).toEqual({
      used: 3,
      limit: 4,
      windowHours: 4,
      resetsAt: new Date(at(4)).toISOString(),
    });
  });

  it('refuses a message that would exceed the limit until the window resets', async () => {
    const db = await fixture();
    await chargeMessage(db, 'owner', limit, 3, at(0));
    const error = await chargeMessage(db, 'owner', limit, 2, at(1.5)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 429,
      details: { code: 'message_limit', retryAt: new Date(at(4)).toISOString() },
    });
    expect((error as HttpError).message).toBe(
      "You've reached your message limit. It resets in 2h 30m.",
    );
    // The refused message spent nothing, and a lighter one still fits.
    await chargeMessage(db, 'owner', limit, 1, at(2));
    expect((await loadMessageBudget(db, 'owner', limit, at(2))).used).toBe(4);
  });

  it('starts a fresh window after the old one ends', async () => {
    const db = await fixture();
    await chargeMessage(db, 'owner', limit, 4, at(0));
    expect(await loadMessageBudget(db, 'owner', limit, at(4))).toMatchObject({
      used: 0,
      resetsAt: null,
    });
    expect(await chargeMessage(db, 'owner', limit, 1, at(5))).toBe(new Date(at(5)).toISOString());
    expect(await loadMessageBudget(db, 'owner', limit, at(5))).toMatchObject({
      used: 1,
      resetsAt: new Date(at(9)).toISOString(),
    });
  });

  it('refunds a charge only within the window that took it', async () => {
    const db = await fixture();
    const window = await chargeMessage(db, 'owner', limit, 2, at(0));
    await refundMessage(db, 'owner', window, 2);
    expect((await loadMessageBudget(db, 'owner', limit, at(0))).used).toBe(0);
    await chargeMessage(db, 'owner', limit, 1, at(5));
    await refundMessage(db, 'owner', window, 1);
    expect((await loadMessageBudget(db, 'owner', limit, at(5))).used).toBe(1);
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

it('refuses a model heavier than the whole budget without opening a fresh window', async () => {
  const db = await fixture();
  const error = await chargeMessage(db, 'owner', { limit: 1, windowHours: 4 }, 3, at(0)).catch(
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({
    status: 429,
    details: { code: 'message_limit', weight: 3, retryAt: new Date(at(4)).toISOString() },
  });
  expect(await db.prepare('SELECT COUNT(*) AS count FROM message_windows').first()).toEqual({
    count: 0,
  });
});
it('refuses an oversized model without reopening or spending an expired window', async () => {
  const db = await fixture();
  await chargeMessage(db, 'owner', limit, 1, at(0));
  const budget = { limit: 1, windowHours: 4 };
  const error = await chargeMessage(db, 'owner', budget, 3, at(5)).catch(
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({
    status: 429,
    details: { code: 'message_limit', weight: 3, retryAt: new Date(at(9)).toISOString() },
  });
  expect(await db.prepare('SELECT started_at,used FROM message_windows').first()).toEqual({
    started_at: new Date(at(0)).toISOString(),
    used: 1,
  });
  expect(await chargeMessage(db, 'owner', budget, 1, at(5))).toBe(new Date(at(5)).toISOString());
});

it('accounts unlimited usage and refunds it while preserving spending through plan changes', async () => {
  const db = await fixture();
  const unlimited = { limit: null, windowHours: 4 };
  await chargeMessage(db, 'owner', limit, 3, at(0));
  const window = await chargeMessage(db, 'owner', unlimited, 10, at(1));
  expect(await loadMessageBudget(db, 'owner', unlimited, at(1))).toEqual({
    used: 13,
    limit: null,
    windowHours: 4,
    resetsAt: new Date(at(4)).toISOString(),
  });
  await refundMessage(db, 'owner', window, 2);
  await expect(chargeMessage(db, 'owner', limit, 1, at(2))).rejects.toMatchObject({ status: 429 });
  expect((await loadMessageBudget(db, 'owner', limit, at(2))).used).toBe(11);
  await chargeMessage(db, 'owner', { limit: 12, windowHours: 4 }, 1, at(2));
  expect((await loadMessageBudget(db, 'owner', unlimited, at(2))).used).toBe(12);
  await chargeMessage(db, 'owner', unlimited, 30, at(5));
  expect(await loadMessageBudget(db, 'owner', unlimited, at(5))).toMatchObject({
    used: 30,
    resetsAt: new Date(at(9)).toISOString(),
  });
});

it('reads explicit unlimited legacy configuration without inventing a numeric cap', () => {
  expect(messageLimitFrom({ MESSAGE_LIMIT: 'unlimited', MESSAGE_WINDOW_HOURS: '2' })).toEqual({
    limit: null,
    windowHours: 2,
  });
});

it('returns each atomic charge window even when another request rolls the window over', async () => {
  const db = await fixture();
  const [oldWindow, newWindow] = await Promise.all([
    chargeMessage(db, 'owner', limit, 1, at(0)),
    chargeMessage(db, 'owner', limit, 1, at(5)),
  ]);
  expect(oldWindow).toBe(new Date(at(0)).toISOString());
  expect(newWindow).toBe(new Date(at(5)).toISOString());
  await refundMessage(db, 'owner', oldWindow, 1);
  expect((await loadMessageBudget(db, 'owner', limit, at(5))).used).toBe(1);
});

it('admits only weighted requests that fit when charging concurrently', async () => {
  const db = await fixture();
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      chargeMessage(db, 'owner', { limit: 5, windowHours: 4 }, 2, at(0)),
    ),
  );
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
  expect((await loadMessageBudget(db, 'owner', limit, at(0))).used).toBe(4);
});
