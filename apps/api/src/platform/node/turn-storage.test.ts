import { afterEach, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite';
import { SQLTurnStorage } from './turn-storage';

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const db = openSqliteDatabase(':memory:');
  databases.push(db);
  await db.exec(`CREATE TABLE turns(id TEXT PRIMARY KEY, execution_generation INTEGER NOT NULL);
    INSERT INTO turns VALUES('turn',0);
    CREATE TABLE turn_execution_state(turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE, state_json TEXT NOT NULL, alarm_at BIGINT, ended_at BIGINT);
    CREATE TABLE turn_events(turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE, generation INTEGER NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(turn_id,sequence));`);
  return { db, storage: new SQLTurnStorage(db, 'turn') };
}
const descriptor = (generation: number) => ({
  version: 1 as const,
  startedAt: 1,
  deadlineAt: 9999,
  model: 'fixture',
  generation,
});

it('persists state and ordered full history across generation changes and storage restarts', async () => {
  const { db, storage } = await fixture();
  expect(await storage.state()).toBeUndefined();
  await storage.begin('turn');
  await storage.append(1, { type: 'text-start', id: 'answer' });
  await db.prepare('UPDATE turns SET execution_generation=1 WHERE id=?').bind('turn').run();
  await storage.begin('turn', descriptor(1));
  await storage.append(2, { type: 'text-delta', id: 'answer', delta: 'answer' });
  await storage.setAlarm(5000);
  const restarted = new SQLTurnStorage(db, 'turn');
  expect(await restarted.state()).toEqual({ turnId: 'turn', execution: descriptor(1) });
  expect(await restarted.chunks()).toEqual([
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: 'answer' },
  ]);
  await restarted.begin('turn');
  expect(await restarted.state()).toEqual({ turnId: 'turn', execution: descriptor(1) });
  await restarted.end(3000);
  expect(await restarted.state()).toMatchObject({ endedAt: 3000 });
  expect(await db.prepare('SELECT alarm_at,ended_at FROM turn_execution_state').first()).toEqual({
    alarm_at: 5000,
    ended_at: 3000,
  });
  await restarted.clear();
  expect(await restarted.state()).toBeUndefined();
  expect(await restarted.chunks()).toEqual([]);
  expect(await db.prepare('SELECT id FROM turns').first()).toEqual({ id: 'turn' });
});

it('rejects stale generation appends and cannot end or clear a newer execution', async () => {
  const { db, storage: old } = await fixture();
  await old.begin('turn');
  await old.append(1, { type: 'text-start', id: 'old' });
  await db.prepare('UPDATE turns SET execution_generation=1 WHERE id=?').bind('turn').run();
  const current = new SQLTurnStorage(db, 'turn');
  await current.begin('turn', descriptor(1));
  await expect(old.append(2, { type: 'text-end', id: 'old' })).rejects.toThrow('generation');
  await expect(old.begin('turn', descriptor(0))).rejects.toThrow('generation');
  await old.end(7);
  await old.clear();
  expect(await current.state()).toEqual({ turnId: 'turn', execution: descriptor(1) });
  expect(await current.chunks()).toHaveLength(1);
  await current.append(2, { type: 'text-end', id: 'new' });
  expect(await current.chunks()).toHaveLength(2);
});
