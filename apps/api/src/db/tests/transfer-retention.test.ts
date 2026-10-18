import { expect, it } from 'vitest';
import { openSqliteDatabase } from '../../platform/node/sqlite';
import { applySqliteMigrations } from '../../platform/node/sqlite-migrations';
import { exportApplicationSnapshot, importApplicationSnapshot } from '../transfer';

async function fixture() {
  const db = openSqliteDatabase(':memory:');
  await applySqliteMigrations(db, new URL('../../../migrations/', import.meta.url));
  return db;
}
async function seed(db: Awaited<ReturnType<typeof fixture>>) {
  await db.exec(
    "INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES('owner','owner','now','now'); INSERT INTO conversations(id,owner_id,last_user_activity_at,expires_at,created_at,retention_disabled) VALUES('chat','owner','now','now','now',1)",
  );
}
it.each([1, 2])('imports schema v%i snapshots with correct retention defaults', async (version) => {
  const source = await fixture(),
    target = await fixture();
  try {
    await seed(source);
    const snapshot = await exportApplicationSnapshot(source);
    snapshot.schemaVersion = version;
    if (version === 1) {
      delete snapshot.tables.conversations[0].retention_disabled;
      delete snapshot.tables.conversations[0].purge_started_at;
      delete snapshot.tables.conversations[0].purge_token;
    }
    await importApplicationSnapshot(target, snapshot);
    expect(
      await target.prepare('SELECT retention_disabled,purge_started_at FROM conversations').first(),
    ).toEqual({ retention_disabled: version === 1 ? 0 : 1, purge_started_at: null });
  } finally {
    source.close();
    target.close();
  }
});
it('rejects pending retention cleanup on export and import without writing target rows', async () => {
  const source = await fixture(),
    target = await fixture();
  try {
    await seed(source);
    const snapshot = await exportApplicationSnapshot(source);
    snapshot.tables.conversations[0].status = 'purging';
    await expect(importApplicationSnapshot(target, snapshot)).rejects.toThrow(/cleanup/);
    expect(await target.prepare('SELECT count(*) AS n FROM users').first()).toEqual({ n: 0 });
    await source.prepare("UPDATE conversations SET status='purging',purge_started_at='now'").run();
    await expect(exportApplicationSnapshot(source)).rejects.toThrow(/cleanup/);
  } finally {
    source.close();
    target.close();
  }
});
