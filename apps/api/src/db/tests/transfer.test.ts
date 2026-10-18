import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteDatabase } from '../../platform/node/sqlite';
import { applySqliteMigrations } from '../../platform/node/sqlite-migrations';
import { exportApplicationSnapshot, importApplicationSnapshot } from '../transfer';

it('round-trips application ownership, cyclic branch/message links, private auth state and research lexical data atomically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-transfer-'));
  const source = openSqliteDatabase(join(directory, 'source.sqlite'));
  const target = openSqliteDatabase(join(directory, 'target.sqlite'));
  try {
    await applySqliteMigrations(source, new URL('../../../migrations/', import.meta.url));
    await applySqliteMigrations(target, new URL('../../../migrations/', import.meta.url));
    await source.exec(`INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES ('owner','subject','now','now');
      INSERT INTO conversations(id,owner_id,last_user_activity_at,expires_at,created_at) VALUES ('chat','owner','now','2999','now');
      INSERT INTO conversation_branches(id,conversation_id,owner_id,created_at) VALUES ('branch','chat','owner','now');
      INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES ('turn','request','chat','owner','completed','now','branch','branch');
      INSERT INTO messages(id,conversation_id,owner_id,role,created_at,ui_message,turn_id,origin_branch_id) VALUES ('message','chat','owner','assistant','now','{}','turn','branch');
      UPDATE conversation_branches SET head_message_id='message' WHERE id='branch';
      INSERT INTO auth_user(id,name,email,created_at,updated_at) VALUES ('auth','Name','user@example.com','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO auth_session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('session','private-token','auth','2027-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO research_sources VALUES ('source','owner','https://example.com','blob','hash','model','now');
      INSERT INTO research_chunks VALUES ('chunk','source','owner',0,'lexical token','[1,0]','model');`);
    const snapshot = await exportApplicationSnapshot(source);
    await importApplicationSnapshot(target, JSON.parse(JSON.stringify(snapshot)));
    expect(
      await target.prepare('SELECT head_message_id FROM conversation_branches').first(),
    ).toEqual({ head_message_id: 'message' });
    expect(await target.prepare('SELECT token FROM auth_session').first()).toEqual({
      token: 'private-token',
    });
    expect(
      await target
        .prepare(
          "SELECT chunk_id FROM research_chunks_fts WHERE research_chunks_fts MATCH 'lexical'",
        )
        .first(),
    ).toEqual({ chunk_id: 'chunk' });
    await target.integrityCheck();
    await expect(importApplicationSnapshot(target, snapshot)).rejects.toThrow(/empty/);
    const invalid = { ...snapshot, schemaVersion: 999 };
    await expect(importApplicationSnapshot(target, invalid)).rejects.toThrow(/schema/);
  } finally {
    source.close();
    target.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects invalid rows without leaving a partial import', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-transfer-invalid-'));
  const db = openSqliteDatabase(join(directory, 'app.sqlite'));
  try {
    await applySqliteMigrations(db, new URL('../../../migrations/', import.meta.url));
    const snapshot = await exportApplicationSnapshot(db);
    snapshot.tables.users.push({
      id: 'owner',
      auth_provider: 'clerk',
      auth_subject: 'subject',
      created_at: 'now',
      updated_at: 'now',
      deletion_pending: 0,
    });
    snapshot.tables.notes.push({
      id: 'bad',
      owner_id: 'missing',
      markdown: '',
      revision: 0,
      provenance_json: '[]',
      created_at: 'now',
      updated_at: 'now',
      title: '',
    });
    await expect(importApplicationSnapshot(db, snapshot)).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) AS total FROM users').first()).toEqual({ total: 0 });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
