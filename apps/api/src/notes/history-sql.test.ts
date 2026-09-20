import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

describe('durable note suggestion history', () => {
  it('preserves a rejected suggestion through undo and redo without transcript ownership', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-note-history-')), 'fixture.sqlite');
    const migrations = migration('0000_baseline.sql');
    execFileSync('sqlite3', [db], {
      input: `${migrations}
        INSERT INTO users VALUES ('owner','subject','now','now',0);
        INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at)
          VALUES ('note','owner','Base',0,'[]','now','now');
        INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,base_revision,base_markdown,old_text,new_text,reason,status,created_at,updated_at)
          VALUES ('suggestion','note','owner','deleted-conversation','deleted-message',0,'Base','Base','Changed','Useful','pending','now','now');
        INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,kind,suggestion_id,before_suggestion_status,after_suggestion_status,created_at)
          VALUES ('edit','note','owner','reject',0,1,'Note','Base','[]','Note','Base','[]','suggestion_reject','suggestion','pending','rejected','now');
        UPDATE notes SET revision=1 WHERE id='note';
        UPDATE note_suggestions SET status='rejected' WHERE id='suggestion';
        UPDATE note_edits SET undone=1 WHERE id='edit';
        UPDATE notes SET revision=2 WHERE id='note';
        UPDATE note_suggestions SET status='pending' WHERE id='suggestion';
      `,
    });
    const afterUndo = execFileSync(
      'sqlite3',
      [
        db,
        "SELECT n.revision||':'||s.status FROM notes n JOIN note_suggestions s ON s.note_id=n.id",
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(afterUndo).toBe('2:pending');

    execFileSync('sqlite3', [db], {
      input: `UPDATE note_edits SET undone=0 WHERE id='edit';
        UPDATE notes SET revision=3 WHERE id='note';
        UPDATE note_suggestions SET status='rejected' WHERE id='suggestion';`,
    });
    const afterRedo = execFileSync(
      'sqlite3',
      [
        db,
        "SELECT n.revision||':'||s.status FROM notes n JOIN note_suggestions s ON s.note_id=n.id",
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(afterRedo).toBe('3:rejected');
  });

  it('keeps request idempotency after the opposite history action', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-note-idempotency-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${migration('0000_baseline.sql')}
        INSERT INTO users VALUES ('owner','subject','now','now',0);
        INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','',0,'[]','now','now');
        INSERT INTO note_history_requests VALUES ('owner','note','undo-request','undo',1,'edit','now');
        INSERT INTO note_history_requests VALUES ('owner','note','redo-request','redo',2,'edit','later');`,
    });
    const count = execFileSync(
      'sqlite3',
      [db, "SELECT count(*) FROM note_history_requests WHERE note_id='note'"],
      { encoding: 'utf8' },
    ).trim();
    expect(count).toBe('2');
    expect(() =>
      execFileSync('sqlite3', [db], {
        input:
          "INSERT INTO note_history_requests VALUES ('owner','note','undo-request','undo',3,'edit','retry');",
      }),
    ).toThrow();
  });
});
