import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { batchIfAny, editContext, REGENERATE_ASSISTANT_SQL, regenerationContext } from './routes';

const message = (id: string, role: 'user' | 'assistant', content: string, incomplete = false) => ({
  id,
  role,
  content,
  incomplete,
  createdAt: '2026-01-01',
});
const bind = (sql: string, values: Array<string | null>) => {
  let index = 0;
  return sql.replaceAll('?', () => {
    const value = values[index++];
    return value === null ? 'NULL' : `'${value?.replaceAll("'", "''")}'`;
  });
};

describe('assistant response regeneration', () => {
  it('does not call D1 batch when regeneration has no pre-stream statements', async () => {
    const db = {
      batch: () => {
        throw new Error('No SQL statements detected');
      },
    } as unknown as D1Database;

    await expect(batchIfAny(db, [])).resolves.toBeUndefined();
  });

  it('uses any completed assistant and its preceding user prompt', () => {
    const messages = [
      message('u1', 'user', 'Earlier'),
      message('a1', 'assistant', 'Earlier answer'),
      message('u2', 'user', 'Try this again'),
      message('a2', 'assistant', 'Original answer'),
    ];
    expect(regenerationContext(messages, 'a2')).toEqual({
      assistant: messages[3],
      user: messages[2],
      history: messages.slice(0, 2),
    });
    expect(regenerationContext(messages, 'a1')).toEqual({
      assistant: messages[1],
      user: messages[0],
      history: [],
    });
    expect(
      regenerationContext([...messages.slice(0, 3), message('a2', 'assistant', '', true)], 'a2'),
    ).toBeNull();
  });

  it('forks an edited user prompt before the original prompt', () => {
    const messages = [
      message('u1', 'user', 'Earlier'),
      message('a1', 'assistant', 'Earlier answer'),
      message('u2', 'user', 'Broken prompt'),
      message('a2', 'assistant', '', true),
    ];
    expect(editContext(messages, 'u2')).toEqual({
      user: messages[2],
      history: messages.slice(0, 2),
      replacedAssistant: messages[3],
    });
    expect(editContext(messages, 'a2')).toBeNull();
  });

  it('replaces the latest assistant ID and content at the same sequence only on success', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'walden-regenerate-')), 'fixture.sqlite');
    execFileSync('sqlite3', [db], {
      input: `CREATE TABLE messages (id TEXT PRIMARY KEY,turn_id TEXT,conversation_id TEXT,owner_id TEXT,role TEXT,content TEXT,reasoning TEXT,activity_json TEXT DEFAULT '{}',incomplete INTEGER,sequence INTEGER,created_at TEXT);
        INSERT INTO messages VALUES ('user','old-turn','conversation','owner','user','Prompt',NULL,'{}',0,1,'old');
        INSERT INTO messages VALUES ('old-assistant','old-turn','conversation','owner','assistant','Original',NULL,'{}',0,2,'old');`,
    });
    expect(
      execFileSync(
        'sqlite3',
        [db, "SELECT id||':'||content||':'||sequence FROM messages WHERE role='assistant'"],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('old-assistant:Original:2');

    execFileSync('sqlite3', [db], {
      input: bind(REGENERATE_ASSISTANT_SQL, [
        'new-assistant',
        'new-turn',
        'Replacement',
        null,
        '{"tools":[],"sources":[]}',
        'new',
        'old-assistant',
        'conversation',
        'owner',
        'conversation',
        'owner',
      ]),
    });
    expect(
      execFileSync(
        'sqlite3',
        [db, "SELECT id||':'||content||':'||sequence FROM messages WHERE role='assistant'"],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('new-assistant:Replacement:2');
    expect(
      execFileSync('sqlite3', [db, "SELECT activity_json FROM messages WHERE role='assistant'"], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('{"tools":[],"sources":[]}');
    expect(
      execFileSync('sqlite3', [db, "SELECT count(*) FROM messages WHERE role='user'"], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('1');
  });
});
