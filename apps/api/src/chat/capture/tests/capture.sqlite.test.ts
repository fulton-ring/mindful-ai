import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { appFor, capture, sqliteDatabase } from './capture.fixtures';

describe('atomic first-note capture with SQLite', () => {
  it('rejects a conversation owned by another user', async () => {
    const sqlite = sqliteDatabase();
    sqlite.scalar(
      "INSERT INTO users (id,auth_subject,created_at,updated_at) VALUES ('other','other-subject','2026-01-01','2026-01-01'); UPDATE conversations SET owner_id='other' WHERE id='conversation';",
    );

    expect((await appFor(sqlite.db)(capture)).status).toBe(404);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('0');
  });

  it('rejects capture when a note is already attached', async () => {
    const sqlite = sqliteDatabase();
    sqlite.scalar(
      "INSERT INTO notes (id,owner_id,markdown,revision,created_at,updated_at) VALUES ('existing','owner','Existing',1,'2026-01-01','2026-01-01'); UPDATE conversations SET note_id='existing' WHERE id='conversation';",
    );

    expect((await appFor(sqlite.db)(capture)).status).toBe(409);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('1');
    expect(sqlite.scalar("SELECT note_id FROM conversations WHERE id='conversation';")).toBe(
      'existing',
    );
  });
});

describe('atomic first-note capture transactions with SQLite', () => {
  it('uses SQLite transaction guards to leave no partial note when streaming starts before the batch', async () => {
    const sqlite = sqliteDatabase({
      beforeBatch(path) {
        execFileSync('sqlite3', [path], {
          input:
            "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at) VALUES ('turn','request','conversation','owner','streaming','2026-01-01');",
        });
      },
    });

    const response = await appFor(sqlite.db)(capture);

    expect(response.status).toBe(409);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('0');
    expect(
      sqlite.scalar("SELECT coalesce(note_id,'NULL') FROM conversations WHERE id='conversation';"),
    ).toBe('NULL');
  });

  it('executes the emitted batch SQL transactionally in SQLite and replays its history', async () => {
    const sqlite = sqliteDatabase();
    const request = appFor(sqlite.db);

    const created = await request(capture);
    const replayed = await request(capture);

    expect(created.status).toBe(201);
    expect(replayed.status).toBe(200);
    const firstBody = (await created.json()) as { note: { id: string } };
    const replayBody = (await replayed.json()) as { note: { id: string } };
    expect(firstBody.note).toMatchObject({
      markdown: capture.text,
      revision: 1,
      provenance: [
        {
          from: 0,
          to: capture.text.length,
          origin: 'agent',
          verbatim: true,
          captureId: capture.operationId,
        },
      ],
    });
    expect(replayBody.note.id).toBe(firstBody.note.id);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('1');
    expect(sqlite.scalar('SELECT count(*) FROM note_edits;')).toBe('1');
    expect(sqlite.scalar("SELECT note_id FROM conversations WHERE id='conversation';")).toBe(
      firstBody.note.id,
    );
    expect(sqlite.scalar("SELECT base_revision||':'||result_revision FROM note_edits;")).toBe(
      '0:1',
    );
    expect(
      sqlite.scalar(
        "SELECT n.markdown||':'||n.revision FROM notes n JOIN conversations c ON c.note_id=n.id WHERE c.id='conversation';",
      ),
    ).toBe(`${capture.text}:1`);
  });
});

describe('atomic first-note capture rollback with SQLite', () => {
  it('rolls back the emitted SQLite transaction when a batch statement fails', async () => {
    const sqlite = sqliteDatabase({ failAfter: 1 });

    const response = await appFor(sqlite.db)(capture);

    expect(response.status).toBe(500);
    expect(sqlite.scalar('SELECT count(*) FROM notes;')).toBe('0');
    expect(sqlite.scalar('SELECT count(*) FROM note_edits;')).toBe('0');
    expect(
      sqlite.scalar("SELECT coalesce(note_id,'NULL') FROM conversations WHERE id='conversation';"),
    ).toBe('NULL');
  });
});
