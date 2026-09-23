import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('initializes the complete application schema with current defaults and constraints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-baseline-'));
  const db = join(directory, 'test.sqlite');
  try {
    const migrations = new URL('../../migrations/', import.meta.url);
    const files = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    execFileSync('sqlite3', [db], {
      input: files.map((name) => readFileSync(new URL(name, migrations), 'utf8')).join('\n'),
    });
    const query = (sql: string) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();
    expect(
      query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
    ).toBe('20');
    query(`PRAGMA foreign_keys=ON;
      INSERT INTO users VALUES ('owner','subject','now','now',0);
      INSERT INTO notes (id,owner_id,created_at,updated_at) VALUES ('note','owner','now','now');
      INSERT INTO conversations (id,owner_id,note_id,last_user_activity_at,expires_at,created_at) VALUES ('chat','owner','note','now','2999','now');
      INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at) VALUES ('message','chat','owner','assistant','Answer',1,'now');`);
    expect(
      query("SELECT learning_checks_enabled||':'||web_search_enabled FROM conversations"),
    ).toBe('1:1');
    expect(query('SELECT activity_json FROM messages')).toBe('{}');
    expect(() => query('UPDATE conversations SET web_search_enabled=2')).toThrow();
    expect(() =>
      query(
        "INSERT INTO message_highlights (message_id,owner_id,origin,start,end,quote,updated_at) VALUES ('message','owner','user',5,1,'bad','now')",
      ),
    ).toThrow();
    query("PRAGMA foreign_keys=ON; DELETE FROM notes WHERE id='note'");
    expect(query("SELECT coalesce(note_id,'NULL') FROM conversations")).toBe('NULL');
    query("PRAGMA foreign_keys=ON; DELETE FROM users WHERE id='owner'");
    expect(query('SELECT count(*) FROM messages')).toBe('0');
    expect(query('PRAGMA foreign_key_check')).toBe('');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
