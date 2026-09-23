import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deleteAgentMemoryThread } from '../../../agent/memory/memory';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { loadConversation, purgeExpiredConversations } from '../conversations';

vi.mock('../../../agent/memory/memory', () => ({ deleteAgentMemoryThread: vi.fn() }));

async function createRetentionFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'walden-retention-'));
  const file = join(directory, 'fixture.sqlite');
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
      "INSERT INTO notes (id,owner_id,markdown,created_at,updated_at) VALUES ('note','owner','Permanent note','now','now')",
    )
    .run();
  for (const [id, noteId, expiresAt] of [
    ['expired-note', 'note', '2000-01-01'],
    ['expired-empty', null, '2000-01-01'],
    ['active', null, '2999-01-01'],
  ]) {
    await db
      .prepare(
        "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES (?,'owner',?,'Title','now',?,'active','now')",
      )
      .bind(id, noteId, expiresAt)
      .run();
    await db
      .prepare(
        "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,last_user_activity_at,expires_at,created_at) VALUES (?,?,'owner',1,'active','now',?,'now')",
      )
      .bind(id, id, expiresAt)
      .run();
    await db
      .prepare(
        "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id) VALUES (?,?,?,'owner','completed','now',?)",
      )
      .bind(id, id, id, id)
      .run();
    await db
      .prepare(
        "INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,sequence,created_at,origin_branch_id) VALUES (?,?,?,'owner','assistant','Response',1,'now',?)",
      )
      .bind(id, id, id, id)
      .run();
    await db
      .prepare('UPDATE conversation_branches SET head_message_id=? WHERE id=?')
      .bind(id, id)
      .run();
    await db
      .prepare(
        "INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,color,updated_at) VALUES (?,'owner','user',0,8,'Response','yellow','now')",
      )
      .bind(id)
      .run();
  }
  return { db, directory };
}

async function addExpiredBranch(db: D1Database) {
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,last_user_activity_at,expires_at,created_at) VALUES ('old-branch','active','owner',0,'expired','now','2000-01-01','now')",
    )
    .run();
}

async function assertActiveConversation(db: D1Database) {
  await expect(
    loadConversation(db, 'owner', 'active', { branchId: 'old-branch' }),
  ).rejects.toMatchObject({
    status: 410,
  });
  const current = await loadConversation(db, 'owner', 'active');
  expect(current.branchId).toBe('active');
  expect(current.messages.map(({ content }) => content)).toEqual(['Response']);
  expect(deleteAgentMemoryThread).not.toHaveBeenCalled();
}

async function assertExpiredCleanup(db: D1Database, mode: 'scheduled' | 'renew') {
  for (const table of ['messages', 'turns']) {
    expect((await db.prepare(`SELECT id FROM ${table}`).all()).results).toEqual([{ id: 'active' }]);
  }
  expect((await db.prepare('SELECT message_id FROM message_highlights').all()).results).toEqual([
    { message_id: 'active' },
  ]);
  expect(
    (await db.prepare('SELECT id,status FROM conversations ORDER BY id').all()).results,
  ).toEqual([
    { id: 'active', status: 'active' },
    { id: 'expired-note', status: mode === 'renew' ? 'active' : 'expired' },
  ]);
  expect(
    await db
      .prepare("SELECT status,head_message_id FROM conversation_branches WHERE id='expired-note'")
      .first(),
  ).toEqual({ status: mode === 'renew' ? 'active' : 'expired', head_message_id: null });
  expect(await db.prepare("SELECT markdown FROM notes WHERE id='note'").first()).toEqual({
    markdown: 'Permanent note',
  });
  expect(
    vi
      .mocked(deleteAgentMemoryThread)
      .mock.calls.map(([, , id]) => id)
      .sort(),
  ).toEqual(['expired-empty', 'expired-note']);
}

async function resumeArchivedNote(db: D1Database) {
  const archived = await loadConversation(db, 'owner', 'expired-note');
  expect(archived.messages).toEqual([]);
  expect(archived.noteId).toBe('note');
  const resumed = await loadConversation(db, 'owner', 'expired-note', {
    renewExpired: true,
    branchId: archived.branchId,
  });
  expect(resumed.messages).toEqual([]);
  expect(resumed.noteId).toBe('note');
  expect(Date.parse(resumed.expiresAt)).toBeGreaterThan(Date.now());
  await db
    .prepare(
      "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id) VALUES ('resumed','resumed','expired-note','owner','completed','now',?)",
    )
    .bind(resumed.branchId)
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,sequence,created_at,origin_branch_id) VALUES ('resumed','expired-note','resumed','owner','user','Continue from my note',1,'now',?)",
    )
    .bind(resumed.branchId)
    .run();
  await db
    .prepare('UPDATE conversation_branches SET head_message_id=? WHERE id=?')
    .bind('resumed', resumed.branchId)
    .run();
  const reopened = await loadConversation(db, 'owner', 'expired-note');
  expect(reopened.messages.map(({ content }) => content)).toEqual(['Continue from my note']);
  expect(await db.prepare("SELECT markdown FROM notes WHERE id='note'").first()).toEqual({
    markdown: 'Permanent note',
  });
}

it.each(['scheduled', 'renew'] as const)(
  'expires transcripts and highlights through %s while preserving notes and active threads',
  async (mode) => {
    vi.mocked(deleteAgentMemoryThread).mockClear();
    const { db, directory } = await createRetentionFixture();
    try {
      await addExpiredBranch(db);
      await assertActiveConversation(db);
      if (mode === 'renew') {
        const renewed = await loadConversation(db, 'owner', 'expired-note', { renewExpired: true });
        expect(renewed.messages).toEqual([]);
        expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
      }
      await purgeExpiredConversations(db);
      await assertExpiredCleanup(db, mode);
      if (mode === 'scheduled') await resumeArchivedNote(db);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
