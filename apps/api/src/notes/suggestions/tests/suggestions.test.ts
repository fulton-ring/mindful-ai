import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditProposal } from '@walden/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import {
  cancelNoteSuggestionAttempt,
  loadNoteSuggestionBatch,
  persistNoteSuggestion,
} from '../suggestions';

let db: D1Database;

const proposal = (id: string): EditProposal => ({
  id,
  noteId: 'note',
  baseRevision: 0,
  oldText: 'Base',
  newText: `Base\n\n${id}`,
  reason: 'Useful',
  status: 'pending',
});

async function seedRacedSuggestion(db: D1Database, id: string, noteId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO note_suggestions
       (id,note_id,owner_id,conversation_id,source_message_id,base_revision,old_text,new_text,reason,status,created_at,updated_at,branch_id,generation_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      noteId,
      'owner',
      'conversation',
      'source',
      0,
      'Base',
      `Base\n\n${id}`,
      'Raced winner',
      'pending',
      'race',
      'race',
      'branch',
      'source',
    )
    .run();
}

function raceExistingSuggestionInsert(db: D1Database, race: () => Promise<void>): D1Database {
  let armed = true;
  return {
    ...db,
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!armed || !sql.trimStart().startsWith('INSERT INTO note_suggestions')) return statement;
      armed = false;
      let racedStatement: typeof statement;
      racedStatement = new Proxy(statement, {
        get(target, property, receiver) {
          if (property === 'bind')
            return (...values: unknown[]) => {
              target.bind(...values);
              return racedStatement;
            };
          if (property !== 'run') return Reflect.get(target, property, receiver);
          return async () => {
            await race();
            return { success: true, meta: { changes: 0 }, results: [] };
          };
        },
      });
      return racedStatement;
    },
  } as unknown as D1Database;
}

function raceNewSuggestionBatch(db: D1Database, race: () => Promise<void>): D1Database {
  let armed = true;
  return {
    ...db,
    batch: async (statements: D1PreparedStatement[]) => {
      if (armed) {
        armed = false;
        await race();
        throw new Error('simulated concurrent batch conflict');
      }
      return db.batch(statements);
    },
  } as unknown as D1Database;
}

beforeEach(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-suggestions-')), 'notes.sqlite');
  const migrations = new URL('../../../../migrations/', import.meta.url);
  execFileSync('sqlite3', [file], {
    input: readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n'),
  });
  db = sqliteD1Binding(file);
  await db.prepare("INSERT INTO users VALUES ('owner','subject','now','now',0)").run();
  await db
    .prepare(
      "INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','Base',0,'[]','now','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','note','Title','now','2999-01-01','active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,last_user_activity_at,expires_at,created_at) VALUES ('branch','conversation','owner',1,'now','2999-01-01','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at) VALUES ('source','conversation','owner','assistant','Source',1,'now'),('later','conversation','owner','assistant','Later',2,'now')",
    )
    .run();
});

describe('note suggestion persistence', () => {
  it('persists against an exact completed source that is no longer the latest message', async () => {
    const result = await persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      expectedNoteId: 'note',
      expectedRevision: 0,
      proposal: proposal('first-attempt'),
    });

    expect(result).toMatchObject({ created: true, suggestion: { id: 'first-attempt' } });
  });

  it('replays the winning existing-note insert after a concurrent capture', async () => {
    let raced = false;
    const racedDb = raceExistingSuggestionInsert(db, async () => {
      raced = true;
      await seedRacedSuggestion(db, 'raced-existing', 'note');
    });
    const result = await persistNoteSuggestion(racedDb, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      expectedNoteId: 'note',
      expectedRevision: 0,
      proposal: { ...proposal('losing-existing'), replaces: 'raced-existing' },
    });

    expect(raced).toBe(true);
    expect(result).toMatchObject({
      created: false,
      noteId: 'note',
      suggestion: { id: 'raced-existing', status: 'pending' },
    });
    expect(
      await db.prepare("SELECT status FROM note_suggestions WHERE id='raced-existing'").first(),
    ).toEqual({ status: 'pending' });
  });
});

describe('new note suggestion persistence', () => {
  it('replays the winning new-note batch after a concurrent note creation', async () => {
    await db.prepare("UPDATE conversations SET note_id=NULL WHERE id='conversation'").run();
    const racedDb = raceNewSuggestionBatch(db, async () => {
      await db
        .prepare(
          'INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind('raced-note', 'owner', '', 0, '[]', 'race', 'race', 'Title')
        .run();
      await db
        .prepare("UPDATE conversations SET note_id='raced-note' WHERE id='conversation'")
        .run();
      await seedRacedSuggestion(db, 'raced-new', 'raced-note');
    });
    const result = await persistNoteSuggestion(racedDb, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      expectedNoteId: null,
      expectedRevision: null,
      proposal: { ...proposal('losing-new'), replaces: 'raced-new' },
    });

    expect(result).toMatchObject({
      created: false,
      noteId: 'raced-note',
      suggestion: { id: 'raced-new', status: 'pending' },
    });
    expect(
      await db.prepare("SELECT status FROM note_suggestions WHERE id='raced-new'").first(),
    ).toEqual({ status: 'pending' });
  });
});

describe('decided note suggestion persistence', () => {
  it('keeps a decided attempt and creates a fresh explicit attempt for the same source', async () => {
    await persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      expectedNoteId: 'note',
      expectedRevision: 0,
      proposal: proposal('first-attempt'),
    });
    await db
      .prepare("UPDATE note_suggestions SET status='dismissed' WHERE id='first-attempt'")
      .run();

    const result = await persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      expectedNoteId: 'note',
      expectedRevision: 0,
      proposal: proposal('second-attempt'),
      allowAfterDecision: true,
    });

    expect(result).toMatchObject({ created: true, suggestion: { id: 'second-attempt' } });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM note_suggestions WHERE conversation_id='conversation' AND source_message_id='source'",
        )
        .first(),
    ).toEqual({ count: 2 });
  });
});

describe('note suggestion batches', () => {
  it('keeps distinct pending captures from one response while replaying the same capture', async () => {
    const first = await persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      generationKey: 'source:capture:first',
      expectedNoteId: 'note',
      expectedRevision: 0,
      proposal: proposal('first-capture'),
    });
    const second = await persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      generationKey: 'source:capture:second',
      expectedNoteId: 'note',
      expectedRevision: 0,
      proposal: proposal('second-capture'),
    });
    const replay = await persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      generationKey: 'source:capture:first',
      expectedNoteId: 'note',
      expectedRevision: 0,
      proposal: proposal('duplicate-attempt'),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(replay).toMatchObject({ created: false, suggestion: { id: 'first-capture' } });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM note_suggestions WHERE source_message_id='source' AND status='pending'",
        )
        .first(),
    ).toEqual({ count: 2 });
  });

  it('loads one latest suggestion for each ordered operation key', async () => {
    for (const [index, id] of ['first-operation', 'second-operation'].entries())
      await persistNoteSuggestion(db, {
        ownerId: 'owner',
        conversationId: 'conversation',
        branchId: 'branch',
        sourceMessageId: 'source',
        generationKey: index === 0 ? 'source' : `source:operation:${index}`,
        expectedNoteId: 'note',
        expectedRevision: 0,
        proposal: proposal(id),
      });

    const batch = await loadNoteSuggestionBatch(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      generationKey: 'source',
    });

    expect(batch.map(({ id }) => id)).toEqual(['first-operation', 'second-operation']);
  });
});

it('blocks persistence when cancellation wins the race', async () => {
  await cancelNoteSuggestionAttempt(db, {
    ownerId: 'owner',
    conversationId: 'conversation',
    branchId: 'branch',
    sourceMessageId: 'source',
    attemptId: 'cancelled-attempt',
  });

  await expect(
    persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      expectedNoteId: 'note',
      expectedRevision: 0,
      attemptId: 'cancelled-attempt',
      proposal: proposal('cancelled-attempt'),
    }),
  ).rejects.toThrow('Conversation or note changed');
  expect(await db.prepare('SELECT count(*) AS count FROM note_suggestions').first()).toEqual({
    count: 0,
  });
});

it('dismisses only the persisted attempt with undoable suggestion history', async () => {
  for (const id of ['older-attempt', 'cancelled-attempt', 'cancelled-attempt:1'])
    await persistNoteSuggestion(db, {
      ownerId: 'owner',
      conversationId: 'conversation',
      branchId: 'branch',
      sourceMessageId: 'source',
      generationKey: id,
      expectedNoteId: 'note',
      expectedRevision: 0,
      attemptId: id.startsWith('cancelled-attempt') ? 'cancelled-attempt' : id,
      proposal: proposal(id),
    });

  const result = await cancelNoteSuggestionAttempt(db, {
    ownerId: 'owner',
    conversationId: 'conversation',
    branchId: 'branch',
    sourceMessageId: 'source',
    attemptId: 'cancelled-attempt',
  });

  expect(result).toEqual({
    noteId: 'note',
    cancelledSuggestionIds: ['cancelled-attempt', 'cancelled-attempt:1'],
  });
  expect(
    await db
      .prepare('SELECT id,status FROM note_suggestions ORDER BY id')
      .all<{ id: string; status: string }>(),
  ).toMatchObject({
    results: [
      { id: 'cancelled-attempt', status: 'dismissed' },
      { id: 'cancelled-attempt:1', status: 'dismissed' },
      { id: 'older-attempt', status: 'pending' },
    ],
  });
  const edit = await db
    .prepare(
      "SELECT suggestion_changes_json FROM note_edits WHERE operation_id='cancel:cancelled-attempt'",
    )
    .first<{ suggestion_changes_json: string }>();
  expect(JSON.parse(edit?.suggestion_changes_json ?? '[]')).toEqual([
    { id: 'cancelled-attempt', beforeStatus: 'pending', afterStatus: 'dismissed' },
    { id: 'cancelled-attempt:1', beforeStatus: 'pending', afterStatus: 'dismissed' },
  ]);

  await db
    .prepare(
      "UPDATE note_suggestions SET status='pending' WHERE id IN ('cancelled-attempt','cancelled-attempt:1')",
    )
    .run();
  const replay = await cancelNoteSuggestionAttempt(db, {
    ownerId: 'owner',
    conversationId: 'conversation',
    branchId: 'branch',
    sourceMessageId: 'source',
    attemptId: 'cancelled-attempt',
  });
  expect(replay).toEqual({ noteId: 'note', cancelledSuggestionIds: [] });
  expect(
    await db
      .prepare(
        "SELECT count(*) AS count FROM note_edits WHERE operation_id='cancel:cancelled-attempt'",
      )
      .first(),
  ).toEqual({ count: 1 });
});
