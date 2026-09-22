import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../agent/memory/d1-test-binding';
import { HttpError } from '../../http';
import type { Bindings, Variables } from '../../types';
import { notesRoutes } from '../routes';

let db: D1Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

const request = (path: string, body: unknown) =>
  app.request(
    `/api/notes/note${path}`,
    {
      method: path ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DB: db } as Bindings,
  );

async function setupTest() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-multi-dismiss-')), 'notes.sqlite');
  const migrations = new URL('../../../migrations/', import.meta.url);
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
      "INSERT INTO note_suggestions (id,note_id,owner_id,base_revision,base_markdown,old_text,new_text,reason,status,created_at,updated_at) VALUES ('a','note','owner',0,'Base','Base','Base A','A','pending','1','1'),('b','note','owner',0,'Base','Base','Base B','B','pending','2','2')",
    )
    .run();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api/notes', notesRoutes);
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof HttpError ? error.status : 500),
  );
}

describe('typing over multiple suggestions', () => {
  it('dismisses both with the edit and restores both through undo and redo', async () => {
    await setupTest();
    const save = await request('', {
      operationId: 'save',
      baseRevision: 0,
      markdown: 'Typed replacement',
      provenance: [],
      dismissSuggestionIds: ['a', 'b', 'a'],
    });
    expect(save.status).toBe(200);
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'a', status: 'dismissed' },
        { id: 'b', status: 'dismissed' },
      ],
    });

    expect((await request('/undo', { operationId: 'undo', baseRevision: 1 })).status).toBe(200);
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'a', status: 'pending' },
        { id: 'b', status: 'pending' },
      ],
    });

    expect((await request('/redo', { operationId: 'redo', baseRevision: 2 })).status).toBe(200);
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'a', status: 'dismissed' },
        { id: 'b', status: 'dismissed' },
      ],
    });
  });

  it('changes neither note nor suggestions when one ID is stale', async () => {
    await setupTest();
    await db.prepare("UPDATE note_suggestions SET status='dismissed' WHERE id='b'").run();

    const save = await request('', {
      operationId: 'stale-save',
      baseRevision: 0,
      markdown: 'Must not persist',
      provenance: [],
      dismissSuggestionIds: ['a', 'b'],
    });

    expect(save.status).toBe(409);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: 'Base',
        revision: 0,
      },
    );
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'a', status: 'pending' },
        { id: 'b', status: 'dismissed' },
      ],
    });
  });
});
