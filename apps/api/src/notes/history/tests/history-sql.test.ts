import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const baseline = () =>
  readFileSync(new URL('../../../../migrations/0000_baseline.sql', import.meta.url), 'utf8');

describe('durable note history requests', () => {
  it('keeps request idempotency after the opposite history action', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-note-idempotency-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${baseline()}
        INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('owner','subject','now','now',0);
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
