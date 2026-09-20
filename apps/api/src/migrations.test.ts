import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('0002 optional conversation notes migration', () => {
  it('preserves conversations and every child row, then sets note_id null on note deletion', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-migration-')), 'fixture.sqlite');
    const seed = `
      INSERT INTO users (id,auth_subject,created_at,updated_at) VALUES ('user','subject','2026-01-01','2026-01-01');
      INSERT INTO notes (id,owner_id,title,markdown,created_at,updated_at) VALUES ('note','user','Title','Body','2026-01-01','2026-01-01');
      INSERT INTO conversations (id,owner_id,note_id,last_user_activity_at,expires_at,created_at) VALUES ('conversation','user','note','2026-01-01','2999-01-01','2026-01-01');
      INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at) VALUES ('turn','request','conversation','user','completed','2026-01-01');
      INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,sequence,created_at) VALUES ('message','conversation','turn','user','assistant','Hello',1,'2026-01-01');
      INSERT INTO interventions (id,conversation_id,turn_id,owner_id,kind,payload_json,created_at) VALUES ('intervention','conversation','turn','user','record','{}','2026-01-01');
    `;
    execFileSync('sqlite3', [db], {
      input: `${migration('0001_core.sql')}\n${seed}\n${migration('0002_optional_conversation_note.sql')}\n${migration('0003_hidden_personas.sql')}`,
    });

    const counts = execFileSync(
      'sqlite3',
      [
        db,
        '-separator',
        ',',
        `
      SELECT (SELECT count(*) FROM conversations),(SELECT count(*) FROM turns),(SELECT count(*) FROM messages),(SELECT count(*) FROM interventions);
    `,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(counts).toBe('1,1,1,1');

    execFileSync('sqlite3', [db], {
      input: "PRAGMA foreign_keys=ON; DELETE FROM notes WHERE id='note';",
    });
    const noteId = execFileSync(
      'sqlite3',
      [db, "SELECT coalesce(note_id,'NULL') FROM conversations WHERE id='conversation';"],
      { encoding: 'utf8' },
    ).trim();
    expect(noteId).toBe('NULL');
    const preferenceTable = execFileSync(
      'sqlite3',
      [db, "SELECT name FROM sqlite_master WHERE type='table' AND name='hidden_personas';"],
      { encoding: 'utf8' },
    ).trim();
    expect(preferenceTable).toBe('hidden_personas');
  });
});

describe('0004 unified conversation titles migration', () => {
  it('backfills conversation titles, drops persisted note titles, and retains revision snapshots', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-title-migration-')), 'fixture.sqlite');
    const seed = `
      INSERT INTO users (id,auth_subject,created_at,updated_at) VALUES ('user','subject','2026-01-01','2026-01-01');
      INSERT INTO notes (id,owner_id,title,markdown,created_at,updated_at) VALUES ('note','user','Saved title','Body','2026-01-01','2026-01-01');
      INSERT INTO notes (id,owner_id,title,markdown,created_at,updated_at) VALUES ('untitled','user','Untitled note','Body','2026-01-01','2026-01-01');
      INSERT INTO conversations (id,owner_id,note_id,last_user_activity_at,expires_at,created_at) VALUES ('linked','user','note','2026-01-01','2999-01-01','2026-01-01');
      INSERT INTO conversations (id,owner_id,note_id,last_user_activity_at,expires_at,created_at) VALUES ('placeholder','user','untitled','2026-01-01','2999-01-01','2026-01-01');
      INSERT INTO conversations (id,owner_id,note_id,last_user_activity_at,expires_at,created_at) VALUES ('chat','user',NULL,'2026-01-01','2999-01-01','2026-01-01');
      INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at) VALUES ('message','chat','user','user','First thought',1,'2026-01-01');
      INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at) VALUES ('placeholder-message','placeholder','user','user','Meaningful thought',1,'2026-01-01');
      INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,created_at) VALUES ('edit','note','user','op',0,1,'Before','Body','[]','After','Body 2','[]','2026-01-01');
    `;
    execFileSync('sqlite3', [db], {
      input: `${migration('0001_core.sql')}\n${migration('0002_optional_conversation_note.sql')}\n${seed}\n${migration('0003_hidden_personas.sql')}\n${migration('0004_conversation_titles.sql')}`,
    });
    const titles = execFileSync(
      'sqlite3',
      [db, "SELECT id||':'||title FROM conversations ORDER BY id;"],
      { encoding: 'utf8' },
    ).trim();
    expect(titles).toBe('chat:First thought\nlinked:Saved title\nplaceholder:Meaningful thought');
    const noteColumns = execFileSync(
      'sqlite3',
      [db, "SELECT name FROM pragma_table_info('notes') ORDER BY cid;"],
      { encoding: 'utf8' },
    );
    expect(noteColumns).not.toContain('title\n');
    const snapshots = execFileSync(
      'sqlite3',
      [db, "SELECT before_title||':'||after_title FROM note_edits WHERE id='edit';"],
      { encoding: 'utf8' },
    ).trim();
    expect(snapshots).toBe('Before:After');
  });
});

describe('0005 message reasoning migration', () => {
  it('adds nullable reasoning without changing existing messages', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-reasoning-migration-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${migration('0001_core.sql')}\n${migration('0002_optional_conversation_note.sql')}\n${migration('0003_hidden_personas.sql')}\n${migration('0004_conversation_titles.sql')}\n${migration('0005_message_reasoning.sql')}`,
    });

    const reasoningColumn = execFileSync(
      'sqlite3',
      [
        db,
        `SELECT name||':'||"notnull" FROM pragma_table_info('messages') WHERE name='reasoning';`,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(reasoningColumn).toBe('reasoning:0');
  });
});

describe('0009 message activity migration', () => {
  it('backfills existing messages with an empty activity envelope', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-activity-migration-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `${migration('0001_core.sql')}
        ${migration('0002_optional_conversation_note.sql')}
        ${migration('0003_hidden_personas.sql')}
        ${migration('0004_conversation_titles.sql')}
        ${migration('0005_message_reasoning.sql')}
        INSERT INTO users VALUES ('owner','subject','now','now',0);
        INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','Body',0,'[]','now','now');
        INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','Title','now','2999-01-01','active','now');
        INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at) VALUES ('message','conversation','owner','assistant','Answer',1,'now');
        ${migration('0006_durable_note_suggestions.sql')}
        ${migration('0007_exclusive_conversation_notes.sql')}
        ${migration('0008_repeat_note_suggestions.sql')}
        ${migration('0009_message_activity.sql')}`,
    });

    expect(
      execFileSync('sqlite3', [db, "SELECT activity_json FROM messages WHERE id='message'"], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('{}');
  });
});

describe('0010 thread branches migration', () => {
  it('backfills one default branch, message parents, heads, and branch-owned rows', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-branches-migration-')), 'fixture.sqlite');
    const throughNine = Array.from({ length: 9 }, (_, index) => {
      const names = [
        'core',
        'optional_conversation_note',
        'hidden_personas',
        'conversation_titles',
        'message_reasoning',
        'durable_note_suggestions',
        'exclusive_conversation_notes',
        'repeat_note_suggestions',
        'message_activity',
      ];
      return migration(`000${index + 1}_${names[index]}.sql`);
    }).join('\n');
    execFileSync('sqlite3', [db], {
      input: `${throughNine}
        INSERT INTO users VALUES ('owner','subject','now','now',0);
        INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','Title','now','2999-01-01','active','now');
        INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at) VALUES ('turn','request','conversation','owner','completed','now');
        INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,sequence,created_at) VALUES ('user','conversation','turn','owner','user','Question',1,'now');
        INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,sequence,created_at) VALUES ('assistant','conversation','turn','owner','assistant','Answer',2,'now');
        INSERT INTO interventions (id,conversation_id,turn_id,owner_id,kind,payload_json,status,created_at) VALUES ('intervention','conversation','turn','owner','ask','{}','pending','now');
        PRAGMA foreign_keys=OFF;
        INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,base_revision,base_markdown,old_text,new_text,reason,status,created_at,updated_at) VALUES ('orphan','note','owner','deleted-conversation','deleted-message',0,'Body','Body','Better','History','dismissed','old','old');
        PRAGMA foreign_keys=ON;`,
    });
    execFileSync('sqlite3', [db], { input: migration('0010_thread_branches.sql') });

    expect(
      execFileSync(
        'sqlite3',
        [
          db,
          "SELECT b.id||':'||b.head_message_id||':'||t.branch_id||':'||i.branch_id FROM conversation_branches b JOIN turns t ON t.conversation_id=b.conversation_id JOIN interventions i ON i.conversation_id=b.conversation_id",
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('branch:conversation:assistant:branch:conversation:branch:conversation');
    expect(
      execFileSync(
        'sqlite3',
        [
          db,
          "SELECT id||':'||coalesce(parent_message_id,'root')||':'||origin_branch_id FROM messages ORDER BY sequence",
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('user:root:branch:conversation\nassistant:user:branch:conversation');
    expect(
      execFileSync('sqlite3', [db, 'PRAGMA foreign_key_check;'], { encoding: 'utf8' }).trim(),
    ).toBe('note_suggestions|1|notes|2');
    expect(
      execFileSync(
        'sqlite3',
        [
          db,
          "SELECT status||':'||coalesce(branch_id,'none') FROM note_suggestions WHERE id='orphan'",
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('dismissed:none');
  });
});
