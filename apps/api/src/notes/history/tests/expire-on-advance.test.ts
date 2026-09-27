import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { loadNoteState } from '../history';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-expire-advance-')), 'notes.sqlite');
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
      "INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','Keep cash.',1,'[]','now','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','note','Title','now','2999-01-01','active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,created_at) VALUES ('branch','conversation','owner',1,'active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id,conversation_id,owner_id,role,ui_message,created_at,origin_branch_id) VALUES ('source','conversation','owner','assistant',json_object('id','source','role','assistant','parts',json_array(json_object('type','text','text','Source')),'metadata',json_object('createdAt','now')),'now','branch')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,base_revision,old_text,new_text,reason,status,created_at,updated_at,branch_id,generation_key) VALUES ('suggestion','note','owner','conversation','source',1,'Keep cash.','Keep cash. Save three months.','Source','pending','1','1','branch','source')",
    )
    .run();
  return db;
}

// Mirrors the statement the chat turn route runs when a new user message is inserted.
const advance = (db: D1Database) =>
  db
    .prepare(
      "UPDATE note_suggestions SET status='invalidated',updated_at=? WHERE owner_id=? AND conversation_id=? AND status='pending'",
    )
    .bind('2', 'owner', 'conversation')
    .run();

describe('note proposals expire when the conversation advances', () => {
  it('leaves an undecided proposal pending until a new user message arrives', async () => {
    const db = await fixture();
    const before = await loadNoteState(db, 'owner', 'note');
    expect(before.suggestions.map((s) => s.status)).toEqual(['pending']);
  });

  it('drops the proposal once a new user message advances the conversation', async () => {
    const db = await fixture();
    await advance(db);
    const after = await loadNoteState(db, 'owner', 'note');
    expect(after.suggestions.map((s) => s.status)).toEqual(['invalidated']);
  });

  it('does not disturb proposals already accepted or rejected', async () => {
    const db = await fixture();
    await db.prepare("UPDATE note_suggestions SET status='accepted' WHERE id='suggestion'").run();
    await advance(db);
    const after = await loadNoteState(db, 'owner', 'note');
    expect(after.suggestions.map((s) => s.status)).toEqual(['accepted']);
  });
});
