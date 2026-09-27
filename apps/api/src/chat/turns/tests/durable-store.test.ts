import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import {
  appendTurnEvents,
  beginTurnExecution,
  cancelTurn,
  completeTurn,
  readTurnEvents,
} from '../durable-store';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-durable-turn-')), 'fixture.sqlite');
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
      "INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','Title','now','2999-01-01','active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,head_message_id,is_default,created_at) VALUES ('branch','conversation','owner',NULL,1,'now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES ('turn','request','conversation','owner','streaming','now','branch','branch')",
    )
    .run();
  await db
    .prepare(
      "UPDATE turns SET input_json='{}',user_message_id='user',source_branch_id='branch' WHERE id='turn'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO messages(id,conversation_id,turn_id,owner_id,role,content,created_at,origin_branch_id) VALUES('user','conversation','turn','owner','user','Question','now','branch')",
    )
    .run();
  return db;
}

describe('durable turn progress', () => {
  it('replays ordered events and rejects writes from an obsolete execution', async () => {
    const db = await fixture();
    const firstEpoch = (await beginTurnExecution(db, 'turn'))!;
    expect(firstEpoch).toBe(1);
    await appendTurnEvents(db, 'turn', firstEpoch, [{ type: 'text', text: 'first' }]);

    const secondEpoch = (await beginTurnExecution(db, 'turn'))!;
    expect(secondEpoch).toBe(2);
    await appendTurnEvents(db, 'turn', firstEpoch, [{ type: 'text', text: 'stale' }]);
    await appendTurnEvents(db, 'turn', secondEpoch, [{ type: 'text', text: 'second' }]);

    expect((await readTurnEvents(db, 'turn', 0)).map(({ event }) => event)).toEqual([
      { type: 'reset' },
      { type: 'text', text: 'first' },
      { type: 'reset' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('commits a completed answer once and ignores a late Stop', async () => {
    const db = await fixture();
    const epoch = (await beginTurnExecution(db, 'turn'))!;
    const done = {
      type: 'done' as const,
      message: {
        id: 'answer',
        role: 'assistant' as const,
        content: 'Answer',
        createdAt: new Date().toISOString(),
      },
      conversationId: 'conversation',
      branchId: 'branch',
      title: 'Title',
      expiresAt: '2999-01-01',
    };
    expect(await completeTurn(db, 'turn', epoch, done)).toBe(true);
    expect(await completeTurn(db, 'turn', epoch, done)).toBe(false);
    await cancelTurn(db, 'turn', 'owner');
    expect(await db.prepare('SELECT status FROM turns WHERE id=?').bind('turn').first()).toEqual({
      status: 'completed',
    });
    expect(
      await db.prepare("SELECT count(*) AS count FROM messages WHERE role='assistant'").first(),
    ).toEqual({ count: 1 });
    expect(
      await db.prepare('SELECT input_json FROM turns WHERE id=?').bind('turn').first(),
    ).toEqual({ input_json: null });
  });
});

describe('durable Stop', () => {
  it('keeps partial text and blocks an obsolete executor after Stop', async () => {
    const db = await fixture();
    const epoch = (await beginTurnExecution(db, 'turn'))!;
    await appendTurnEvents(db, 'turn', epoch, [{ type: 'text', text: 'Partial' }]);
    await cancelTurn(db, 'turn', 'owner');
    await appendTurnEvents(db, 'turn', epoch, [{ type: 'text', text: 'Too late' }]);
    expect(
      await completeTurn(db, 'turn', epoch, {
        type: 'done',
        message: {
          id: 'answer',
          role: 'assistant',
          content: 'Should not commit',
          createdAt: new Date().toISOString(),
        },
        conversationId: 'conversation',
        branchId: 'branch',
        title: 'Title',
        expiresAt: '2999-01-01',
      }),
    ).toBe(false);
    expect(await db.prepare('SELECT status FROM turns WHERE id=?').bind('turn').first()).toEqual({
      status: 'cancelled',
    });
    expect(await db.prepare("SELECT content FROM messages WHERE role='assistant'").first()).toEqual(
      {
        content: 'Partial',
      },
    );
    expect((await readTurnEvents(db, 'turn', 0)).at(-1)?.event.type).toBe('error');
  });
});
