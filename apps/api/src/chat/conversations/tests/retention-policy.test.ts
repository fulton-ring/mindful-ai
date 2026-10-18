import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { openSqliteDatabase, type SqliteDatabase } from '../../../platform/node/sqlite';
import { purgeExpiredConversations } from '../deletion';
import { createConversation, loadConversation } from '../repository';

vi.mock('../../../agent/memory/memory', () => ({ deleteAgentMemoryThread: vi.fn() }));
const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const db = openSqliteDatabase(':memory:');
  databases.push(db);
  const directory = new URL('../../../../migrations/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    await db.exec(readFileSync(new URL(file, directory), 'utf8'));
  await db.exec(
    "INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES('owner','owner','now','now')",
  );
  return db;
}

it('creates and loads no-expiry conversations without deleting their transcripts', async () => {
  const db = await fixture();
  const conversation = await createConversation(db, 'owner', null, {}, null);
  expect(conversation.expiresAt).toBeNull();
  expect(conversation.branches[0]?.expiresAt).toBeNull();
  await db
    .prepare("UPDATE conversations SET expires_at='2000-01-01' WHERE id=?")
    .bind(conversation.id)
    .run();
  expect((await loadConversation(db, 'owner', conversation.id)).expiresAt).toBeNull();
  await purgeExpiredConversations(db);
  expect(
    await db.prepare('SELECT id FROM conversations WHERE id=?').bind(conversation.id).first('id'),
  ).toBe(conversation.id);
});

it('rebases active deadlines from last activity when policy shortens, lengthens or disables expiry', async () => {
  const { syncOwnerRetention } = await import('../retention');
  const db = await fixture();
  const chat = await createConversation(db, 'owner', null, {});
  const activity = new Date(Date.now() - 3 * 86400000).toISOString();
  await db
    .prepare('UPDATE conversations SET last_user_activity_at=? WHERE id=?')
    .bind(activity, chat.id)
    .run();
  await syncOwnerRetention(db, 'owner', 2);
  expect(
    await db
      .prepare('SELECT expires_at FROM conversations WHERE id=?')
      .bind(chat.id)
      .first('expires_at'),
  ).toBe(new Date(Date.parse(activity) + 2 * 86400000).toISOString());
  await syncOwnerRetention(db, 'owner', 10);
  expect((await loadConversation(db, 'owner', chat.id)).expiresAt).toBe(
    new Date(Date.parse(activity) + 10 * 86400000).toISOString(),
  );
  await syncOwnerRetention(db, 'owner', null);
  expect((await loadConversation(db, 'owner', chat.id)).expiresAt).toBeNull();
  await syncOwnerRetention(db, 'owner', 1);
  await purgeExpiredConversations(db);
  expect(
    await db.prepare('SELECT id FROM conversations WHERE id=?').bind(chat.id).first(),
  ).toBeNull();
});

it('does not revive purged note transcripts and does not rewrite unchanged policy rows', async () => {
  const { syncOwnerRetention } = await import('../retention');
  const db = await fixture();
  await db.exec(
    "INSERT INTO notes(id,owner_id,markdown,created_at,updated_at) VALUES('note','owner','Permanent','now','now')",
  );
  const chat = await createConversation(db, 'owner', 'note', {});
  await db
    .prepare(
      "UPDATE conversations SET last_user_activity_at='2000-01-01T00:00:00.000Z',expires_at='2000-01-08T00:00:00.000Z' WHERE id=?",
    )
    .bind(chat.id)
    .run();
  await purgeExpiredConversations(db);
  await syncOwnerRetention(db, 'owner', null);
  expect(
    await db
      .prepare('SELECT status,retention_disabled FROM conversations WHERE id=?')
      .bind(chat.id)
      .first(),
  ).toEqual({ status: 'expired', retention_disabled: 0 });
  const renewed = await loadConversation(db, 'owner', chat.id, {
    renewExpired: true,
    retentionIdleDays: null,
  });
  expect(renewed.expiresAt).toBeNull();
  expect(renewed.messages).toEqual([]);
  await syncOwnerRetention(db, 'owner', null);
  const before = db.native.prepare('SELECT total_changes() AS n').get()!.n;
  await syncOwnerRetention(db, 'owner', null);
  expect(db.native.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
  expect(await db.prepare("SELECT markdown FROM notes WHERE id='note'").first('markdown')).toBe(
    'Permanent',
  );
});

it('claims an expiry before external deletion and retries failed cleanup without reviving content', async () => {
  const { syncOwnerRetention } = await import('../retention');
  const db = await fixture();
  await db.exec(
    "INSERT INTO notes(id,owner_id,created_at,updated_at) VALUES('note','owner','now','now')",
  );
  const chat = await createConversation(db, 'owner', 'note', {});
  await db
    .prepare("UPDATE conversations SET expires_at='2000-01-01' WHERE id=?")
    .bind(chat.id)
    .run();
  let attempts = 0;
  const cleanup = async () => {
    attempts++;
    expect(
      await db.prepare('SELECT status FROM conversations WHERE id=?').bind(chat.id).first('status'),
    ).toBe('purging');
    await syncOwnerRetention(db, 'owner', null);
    await expect(
      loadConversation(db, 'owner', chat.id, { renewExpired: true, retentionIdleDays: null }),
    ).rejects.toMatchObject({ status: 410 });
    if (attempts === 1) throw new Error('temporary object-store failure');
  };
  await expect(purgeExpiredConversations(db, undefined, cleanup)).rejects.toThrow(
    'temporary object-store failure',
  );
  expect(
    await db.prepare('SELECT status FROM conversations WHERE id=?').bind(chat.id).first('status'),
  ).toBe('purging');
  await purgeExpiredConversations(db, undefined, cleanup);
  expect(attempts).toBe(1);
  await db
    .prepare("UPDATE conversations SET purge_started_at='2000-01-01' WHERE id=?")
    .bind(chat.id)
    .run();
  await purgeExpiredConversations(db, undefined, cleanup);
  expect(attempts).toBe(2);
  expect(
    await db.prepare('SELECT status FROM conversations WHERE id=?').bind(chat.id).first('status'),
  ).toBe('expired');
});

it.each([false, true])(
  'does not overwrite a scheduler claim after stale expiry reads (renew=%s)',
  async (renewExpired) => {
    const db = await fixture();
    await db.exec(
      "INSERT INTO notes(id,owner_id,created_at,updated_at) VALUES('note','owner','now','now')",
    );
    const chat = await createConversation(db, 'owner', 'note', {});
    await db
      .prepare("UPDATE conversations SET expires_at='2000-01-01' WHERE id=?")
      .bind(chat.id)
      .run();
    let raced = false;
    const view = {
      ...db,
      prepare(sql: string) {
        if (
          !raced &&
          (sql.startsWith('DELETE FROM interventions') ||
            sql.startsWith("UPDATE conversations SET status='purging'"))
        ) {
          raced = true;
          db.native
            .prepare(
              "UPDATE conversations SET status='purging',purge_started_at='now',purge_token='scheduler' WHERE id=?",
            )
            .run(chat.id);
        }
        return db.prepare(sql);
      },
    };
    await expect(loadConversation(view, 'owner', chat.id, { renewExpired })).rejects.toMatchObject({
      status: 410,
    });
    expect(
      await db
        .prepare('SELECT status,purge_token FROM conversations WHERE id=?')
        .bind(chat.id)
        .first(),
    ).toEqual({ status: 'purging', purge_token: 'scheduler' });
  },
);

it('reloads a policy change that won before request-time expiry cleanup', async () => {
  const db = await fixture();
  const chat = await createConversation(db, 'owner', null, {});
  await db
    .prepare("UPDATE conversations SET expires_at='2000-01-01' WHERE id=?")
    .bind(chat.id)
    .run();
  let raced = false;
  const view = {
    ...db,
    prepare(sql: string) {
      if (!raced && sql.startsWith("UPDATE conversations SET status='purging'")) {
        raced = true;
        db.native.prepare('UPDATE conversations SET retention_disabled=1 WHERE id=?').run(chat.id);
      }
      return db.prepare(sql);
    },
  };
  expect((await loadConversation(view, 'owner', chat.id)).expiresAt).toBeNull();
  expect(
    await db.prepare('SELECT status FROM conversations WHERE id=?').bind(chat.id).first('status'),
  ).toBe('active');
});

it('does not clear branch heads when a concurrent claim defeats the renewal CAS', async () => {
  const db = await fixture();
  await db.exec(
    "INSERT INTO notes(id,owner_id,created_at,updated_at) VALUES('note','owner','now','now')",
  );
  const chat = await createConversation(db, 'owner', 'note', {});
  await db
    .prepare("UPDATE conversations SET expires_at='2000-01-01' WHERE id=?")
    .bind(chat.id)
    .run();
  let raced = false;
  const view = {
    ...db,
    prepare(sql: string) {
      if (!raced && sql.startsWith("UPDATE conversations SET status='active'")) {
        raced = true;
        db.native
          .prepare(
            "INSERT INTO messages(id,conversation_id,owner_id,role,ui_message,created_at) VALUES('replacement',?,'owner','assistant','{}','now')",
          )
          .run(chat.id);
        db.native
          .prepare(
            "UPDATE conversation_branches SET head_message_id='replacement' WHERE conversation_id=?",
          )
          .run(chat.id);
        db.native
          .prepare("UPDATE conversations SET status='purging',purge_token='scheduler' WHERE id=?")
          .run(chat.id);
      }
      return db.prepare(sql);
    },
  };
  await expect(
    loadConversation(view, 'owner', chat.id, { renewExpired: true }),
  ).rejects.toMatchObject({ status: 410 });
  expect(
    await db
      .prepare('SELECT head_message_id FROM conversation_branches WHERE conversation_id=?')
      .bind(chat.id)
      .first('head_message_id'),
  ).toBe('replacement');
});
