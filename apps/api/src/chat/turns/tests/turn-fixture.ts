import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { uiMessageSql } from '../../../tests/ui-messages';
import type { Bindings } from '../../../types';
import { TurnSession, type TurnState, type TurnStorage } from '../turn-session';

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

/** Per-turn storage held in memory, as the turn's Durable Object would keep it. */
export function memoryTurnStorage(): TurnStorage & { alarmAt?: number } {
  let state: TurnState | undefined;
  const chunks: WaldenUIMessageChunk[] = [];
  const storage: TurnStorage & { alarmAt?: number } = {
    state: async () => state && { ...state },
    chunks: () => [...chunks],
    begin: async (turnId) => {
      state = { turnId };
    },
    append: (seq, chunk) => {
      chunks[seq - 1] = chunk;
    },
    end: async (endedAt) => {
      if (state) state = { ...state, endedAt };
    },
    setAlarm: async (at) => {
      storage.alarmAt = at;
    },
    clear: async () => {
      state = undefined;
      chunks.length = 0;
      storage.alarmAt = undefined;
    },
  };
  return storage;
}

/** Stands in for the CHAT_TURN namespace: one session per turn, as one object per turn. */
export function turnObjects(env: () => Bindings) {
  const sessions = new Map<string, TurnSession>();
  const session = (turnId: string) => {
    let found = sessions.get(turnId);
    if (!found) {
      found = new TurnSession(env(), memoryTurnStorage(), (task) => void task.catch(() => {}));
      sessions.set(turnId, found);
    }
    return found;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (turnId: string) => session(turnId),
  } as unknown as Bindings['CHAT_TURN'];
  return { namespace, session };
}

/** Reads a UI message stream response to its end; the chunks and whether it ended with [DONE]. */
export async function readTurnStream(response: Response) {
  const chunks: WaldenUIMessageChunk[] = [];
  let done = false;
  if (response.status === 204) return { chunks, done, ids: [] as number[] };
  const text = await response.text();
  const ids: number[] = [];
  for (const block of text.split('\n\n')) {
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (data === undefined) continue;
    if (data === '[DONE]') done = true;
    else {
      chunks.push(JSON.parse(data) as WaldenUIMessageChunk);
      ids.push(Number(/^id: (\d+)$/m.exec(block)?.[1]));
    }
  }
  return { chunks, done, ids };
}
