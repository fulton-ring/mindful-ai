import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDurableStream, NEXT_USER_SEQUENCE_SQL } from './routes';

describe('durable chat stream cancellation', () => {
  it('runs cancellation immediately while cleanup continues in waitUntil', async () => {
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const abort = vi.fn();
    const waitUntil = vi.fn();
    const stream = createDurableStream(() => cleanup, abort, waitUntil);

    const reader = stream.getReader();
    const cancellation = reader.cancel();

    expect(abort).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(cleanup);
    finish();
    await cancellation;
  });
});

describe('cancelled turn sequence reservation', () => {
  it('keeps the delayed partial assistant slot ahead of the next user message', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-cancel-sequence-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          UNIQUE(conversation_id, sequence)
        );
        INSERT INTO messages VALUES ('old-user','conversation','user','Stop this',1);
        INSERT INTO messages VALUES ('new-user','conversation','user','Next question',(${NEXT_USER_SEQUENCE_SQL.replace('?', "'conversation'")}));
        INSERT INTO messages VALUES ('old-partial','conversation','assistant','Partial answer',2);
      `,
    });

    const rows = execFileSync(
      'sqlite3',
      [db, "SELECT role||':'||sequence FROM messages ORDER BY sequence"],
      { encoding: 'utf8' },
    ).trim();
    expect(rows).toBe('user:1\nassistant:2\nuser:3');
  });
});
