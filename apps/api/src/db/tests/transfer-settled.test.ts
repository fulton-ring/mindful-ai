import { expect, it } from 'vitest';
import { openSqliteDatabase } from '../../platform/node/sqlite';
import { applySqliteMigrations } from '../../platform/node/sqlite-migrations';
import { exportApplicationSnapshot, importApplicationSnapshot } from '../transfer';

async function fixture() {
  const db = openSqliteDatabase(':memory:');
  await applySqliteMigrations(db, new URL('../../../migrations/', import.meta.url));
  return db;
}

async function seedTurn(db: Awaited<ReturnType<typeof fixture>>) {
  await db.exec(`INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES ('owner','subject','now','now');
    INSERT INTO conversations(id,owner_id,last_user_activity_at,expires_at,created_at) VALUES ('chat','owner','now','2999','now');
    INSERT INTO conversation_branches(id,conversation_id,owner_id,created_at) VALUES ('branch','chat','owner','now');
    INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES ('turn','request','chat','owner','streaming','now','branch','branch');
    INSERT INTO turn_execution_state(turn_id,state_json) VALUES ('turn','{"pendingTool":"external-write"}');`);
}

it('rejects exporting an unsettled turn without modifying its recovery state', async () => {
  const db = await fixture();
  try {
    await seedTurn(db);
    await expect(exportApplicationSnapshot(db)).rejects.toThrow(/settled turns/);
    expect(await db.prepare('SELECT status FROM turns').first('status')).toBe('streaming');
    expect(
      await db.prepare('SELECT state_json FROM turn_execution_state').first('state_json'),
    ).toBe('{"pendingTool":"external-write"}');
  } finally {
    db.close();
  }
});

it('rejects importing an unsettled snapshot before writing or scheduling recovery in the target', async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    await seedTurn(source);
    await source.prepare("UPDATE turns SET status='completed'").run();
    const snapshot = await exportApplicationSnapshot(source);
    snapshot.tables.turns[0].status = 'streaming';
    await expect(importApplicationSnapshot(target, snapshot)).rejects.toThrow(/settled turns/);
    for (const table of ['users', 'turns', 'turn_execution_state']) {
      expect(await target.prepare(`SELECT count(*) AS total FROM ${table}`).first('total')).toBe(0);
    }
  } finally {
    source.close();
    target.close();
  }
});
