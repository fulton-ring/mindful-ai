import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../agent/memory/d1-test-binding';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';
import { loadNoteState } from './history';
import { notesRoutes } from './routes';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-note-rename-')), 'notes.sqlite');
  const migrations = new URL('../../migrations/', import.meta.url);
  execFileSync('sqlite3', [file], {
    input: readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n'),
  });
  const db = sqliteD1Binding(file);
  await db.prepare("INSERT INTO users VALUES ('owner','subject','now','now',0)").run();
  await db
    .prepare(
      "INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title) VALUES ('note','owner','Body.',3,'[]','now','now','Original name')",
    )
    .run();
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api/notes', notesRoutes);
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof HttpError ? error.status : 500),
  );
  const rename = (id: string, title: unknown) =>
    app.request(
      `/api/notes/${id}/title`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      },
      { DB: db } as Bindings,
    );
  return { db, rename };
}

describe('renaming a note', () => {
  it('renames without touching the markdown or the content revision', async () => {
    const { db, rename } = await fixture();
    const before = await loadNoteState(db, 'owner', 'note');

    expect((await rename('note', '  Offsite   planning ')).status).toBe(200);

    const after = await loadNoteState(db, 'owner', 'note');
    // Whitespace collapsed, name changed, content untouched.
    expect(after.note.title).toBe('Offsite planning');
    expect(after.note.markdown).toBe(before.note.markdown);
    expect(after.note.revision).toBe(before.note.revision);
  });

  it('rejects an empty name rather than leaving the note unnamed', async () => {
    const { rename } = await fixture();
    expect((await rename('note', '')).status).toBe(400);
  });

  it('does not rename a note owned by someone else', async () => {
    const { rename } = await fixture();
    expect((await rename('missing-note', 'Nice try')).status).toBe(404);
  });
});
