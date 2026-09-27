import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ deleteAgentMemoryThread: vi.fn() }));
vi.mock('../../../agent/memory/memory', () => ({
  deleteAgentMemoryThread: mocks.deleteAgentMemoryThread,
}));

import {
  conversationDeleteSucceeded,
  EXPLICIT_ARCHIVE_CONVERSATION_SQL,
  EXPLICIT_DELETE_CONVERSATION_SQL,
  EXPLICIT_DELETE_NOTE_SQL,
  purgeExpiredConversations,
} from '../deletion';

const migration = (name: string) =>
  readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), 'utf8');
const schema = () =>
  'PRAGMA foreign_keys=ON;\n' +
  readdirSync(new URL('../../../../migrations/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map(migration)
    .join('\n');
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const bind = (sql: string, ...values: string[]) => {
  let index = 0;
  return sql.replaceAll('?', () => quote(values[index++] ?? ''));
};
const query = (db: string, sql: string) =>
  execFileSync('sqlite3', [db, '-separator', ',', sql], { encoding: 'utf8' }).trim();
const sqliteD1 = (path: string) =>
  ({
    prepare(sql: string) {
      let values: string[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args.map(String);
          return statement;
        },
        async all<T>() {
          const output = query(path, bind(sql, ...values));
          return {
            results: output
              ? output.split('\n').map((row) => {
                  const [id, owner_id] = row.split(',');
                  return { id, owner_id } as T;
                })
              : [],
          };
        },
        sql: () => bind(sql, ...values),
      };
      return statement;
    },
    async batch(statements: Array<{ sql(): string }>) {
      execFileSync('sqlite3', [path], {
        input: `PRAGMA foreign_keys=ON; BEGIN;${statements.map((statement) => `${statement.sql()};`).join('\n')}COMMIT;`,
      });
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  }) as unknown as D1Database;

describe('conversation aggregate deletion', () => {
  it('archives a thread by deleting its transcript and preserving the standalone note', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-thread-archive-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${schema()}
        INSERT INTO users VALUES ('owner','subject','now','now',0);
        INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title) VALUES ('note','owner','Body',1,'[]','now','now','Learning journal');
        INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('thread','owner','note','Thread','now','2999','active','now');
        INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,created_at) VALUES ('default','thread','owner',1,'active','now');
        INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES ('turn','request','thread','owner','completed','now','default','default');
        INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,created_at) VALUES ('message','thread','turn','owner','assistant','Answer','now');
        INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_markdown,before_provenance_json,after_markdown,after_provenance_json,created_at) VALUES ('edit','note','owner','edit-op',0,1,'','[]','Body','[]','now');
        ${bind(EXPLICIT_ARCHIVE_CONVERSATION_SQL, 'thread', 'owner')};`,
    });

    expect(
      query(
        db,
        "SELECT (SELECT count(*) FROM conversations),(SELECT count(*) FROM notes),(SELECT title FROM notes WHERE id='note'),(SELECT count(*) FROM messages),(SELECT count(*) FROM note_edits)",
      ),
    ).toBe('0,1,Learning journal,0,1');
  });

  it('explicitly deletes the owned note, suggestions, history, and transcript', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-thread-delete-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${schema()}
        INSERT INTO users VALUES ('owner','subject','now','now',0);
        INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','Body',1,'[]','now','now');
        INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('thread','owner','note','Thread','now','2999','active','now');
        INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,created_at) VALUES ('default','thread','owner',1,'active','now');
        INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES ('turn','request','thread','owner','completed','now','default','default');
        INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,created_at) VALUES ('message','thread','turn','owner','assistant','Answer','now');
        INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,branch_id,generation_key,base_revision,old_text,new_text,reason,status,created_at,updated_at) VALUES ('suggestion','note','owner','thread','message','default','message',1,'Body','Better','Reason','pending','now','now');
        INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_markdown,before_provenance_json,after_markdown,after_provenance_json,created_at) VALUES ('edit','note','owner','edit-op',0,1,'','[]','Body','[]','now');
        INSERT INTO note_history_requests VALUES ('owner','note','undo-op','undo',1,'edit','now');
        INSERT INTO users VALUES ('other','other-subject','now','now',0);
        INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('other-note','other','Private',0,'[]','now','now');
        INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('other-thread','other','other-note','Private','now','2999','active','now');
        BEGIN;
        ${bind(EXPLICIT_DELETE_NOTE_SQL, 'owner', 'thread', 'owner')};
        ${bind(EXPLICIT_DELETE_CONVERSATION_SQL, 'thread', 'owner')};
        COMMIT;`,
    });
    expect(
      query(
        db,
        'SELECT (SELECT count(*) FROM conversations),(SELECT count(*) FROM notes),(SELECT count(*) FROM turns),(SELECT count(*) FROM messages),(SELECT count(*) FROM note_suggestions),(SELECT count(*) FROM note_edits),(SELECT count(*) FROM note_history_requests)',
      ),
    ).toBe('1,1,0,0,0,0,0');
    expect(query(db, "SELECT owner_id FROM conversations WHERE id='other-thread'")).toBe('other');
  });

  it('treats a cascaded aggregate change count as a successful delete', () => {
    expect(conversationDeleteSucceeded({ meta: { changes: 7 } } as unknown as D1Result)).toBe(true);
    expect(conversationDeleteSucceeded({ meta: { changes: 0 } } as unknown as D1Result)).toBe(
      false,
    );
  });

  it('seven-day cleanup removes transcript state but retains note suggestions and the thread shell', async () => {
    mocks.deleteAgentMemoryThread.mockClear();
    const db = join(mkdtempSync(join(tmpdir(), 'walden-thread-expiry-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${schema()}
        INSERT INTO users VALUES ('owner','subject','now','now',0);
        INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','Body',0,'[]','now','now');
        INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('thread','owner','note','Thread','old','2020','active','old');
        INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,created_at) VALUES ('default','thread','owner',1,'active','old');
        INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES ('turn','request','thread','owner','completed','old','default','default');
        INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,created_at) VALUES ('message','thread','turn','owner','assistant','Answer','old');
        INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,branch_id,generation_key,base_revision,old_text,new_text,reason,status,created_at,updated_at) VALUES ('suggestion','note','owner','thread','message','default','message',0,'Body','Better','Reason','pending','old','old');`,
    });
    await purgeExpiredConversations(sqliteD1(db));
    expect(mocks.deleteAgentMemoryThread).toHaveBeenCalledWith(
      expect.anything(),
      'owner',
      'thread',
    );
    expect(
      query(
        db,
        "SELECT (SELECT count(*) FROM conversations),(SELECT count(*) FROM notes),(SELECT count(*) FROM note_suggestions),(SELECT count(*) FROM messages),(SELECT status FROM conversations WHERE id='thread'),(SELECT status FROM conversation_branches WHERE id='default')",
      ),
    ).toBe('1,1,1,0,expired,expired');
  });

  it('enforces exclusive note ownership in the baseline', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-shared-note-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${migration('0000_baseline.sql')}
      INSERT INTO users VALUES ('owner','subject','now','now',0);
      INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','',0,'[]','now','now');
      INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('one','owner','note','One','now','2999','active','now');`,
    });
    expect(() =>
      execFileSync('sqlite3', [db], {
        input:
          "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('two','owner','note','Two','now','2999','active','now');",
      }),
    ).toThrow();
    expect(query(db, "SELECT count(*) FROM conversations WHERE note_id='note'")).toBe('1');
  });
});
