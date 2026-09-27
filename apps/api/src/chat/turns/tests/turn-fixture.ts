import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { uiMessageSql } from '../../../tests/ui-messages';

/** A migrated database holding one streaming turn whose user message is stored. */
export async function turnFixture() {
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
  const input = JSON.stringify({ conversation: { title: 'Title', expiresAt: '2999-01-01' } });
  await db.batch([
    db.prepare("INSERT INTO users VALUES ('owner','subject','now','now',0)"),
    db.prepare(
      "INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','Title','now','2999-01-01','active','now')",
    ),
    db.prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,head_message_id,is_default,created_at) VALUES ('branch','conversation','owner',NULL,1,'now')",
    ),
    db.prepare(
      "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES ('turn','request','conversation','owner','streaming','now','branch','branch')",
    ),
    db.prepare("UPDATE turns SET input_json=?,user_message_id='user' WHERE id='turn'").bind(input),
    db.prepare(
      `INSERT INTO messages(id,conversation_id,turn_id,owner_id,role,created_at,origin_branch_id,ui_message) VALUES('user','conversation','turn','owner','user','now','branch',${uiMessageSql('user', 'user', 'Question')})`,
    ),
  ]);
  return db;
}
