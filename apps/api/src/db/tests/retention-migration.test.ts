import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sqliteD1Binding } from '../../agent/memory/tests/d1-test-binding';
import { openSqliteDatabase } from '../../platform/node/sqlite';

it.each(['sqlite', 'd1'])(
  '%s adds retention columns without rebuilding parents or deleting children',
  async (backend) => {
    const directory = mkdtempSync(join(tmpdir(), 'walden-retention-migration-'));
    const path = join(directory, 'application.sqlite');
    const native = openSqliteDatabase(path);
    const db = backend === 'sqlite' ? native : sqliteD1Binding(path);
    const migration = (name: string) =>
      readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
    try {
      await db.exec(migration('0000_baseline.sql') + '\n' + migration('0001_self_hosting.sql'));
      await db.exec(`INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES('owner','owner','now','now');
   INSERT INTO notes(id,owner_id,created_at,updated_at) VALUES('note','owner','now','now');
   INSERT INTO conversations(id,owner_id,note_id,last_user_activity_at,expires_at,created_at) VALUES('chat','owner','note','now','2999','now');
   INSERT INTO conversation_branches(id,conversation_id,owner_id,created_at) VALUES('branch','chat','owner','now');
   INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES('turn','request','chat','owner','completed','now','branch','branch');
   INSERT INTO messages(id,conversation_id,turn_id,owner_id,role,ui_message,created_at) VALUES('message','chat','turn','owner','user','{}','now');`);
      await db.exec(migration('0002_retention_policy.sql'));
      expect(
        await db.prepare('SELECT retention_disabled,purge_started_at FROM conversations').first(),
      ).toEqual({ retention_disabled: 0, purge_started_at: null });
      for (const table of ['notes', 'conversation_branches', 'turns', 'messages'])
        expect(await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 1 });
      await native.integrityCheck();
    } finally {
      native.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
