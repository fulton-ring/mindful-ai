import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { loadNote } from '../../../chat/followups/followup-note-proposals';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { loadNoteState } from '../../history/history';
import { selectNote } from '../../repository';
import { notesRoutes } from '../../routes';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-note-rename-')), 'notes.sqlite');
  const migrations = new URL('../../../../migrations/', import.meta.url);
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
  return { db, app, rename };
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

describe('note reads after renaming', () => {
  it('uses the renamed note title in followup context', async () => {
    const { db, rename } = await fixture();
    await db
      .prepare(
        "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','note','Old conversation title','now','2999-01-01','active','now')",
      )
      .run();
    expect((await rename('note', 'New note title')).status).toBe(200);

    expect((await loadNote(db, 'owner', 'note'))?.title).toBe('New note title');
  });

  it('uses the same untitled fallback for a blank legacy conversation title', async () => {
    const { db, app } = await fixture();
    await db.prepare("UPDATE notes SET title='  ' WHERE id='note'").run();
    await db
      .prepare(
        "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','note','   ','now','2999-01-01','active','now')",
      )
      .run();

    expect((await selectNote(db, 'owner', 'note'))?.title).toBe('Untitled note');
    expect((await loadNoteState(db, 'owner', 'note')).note.title).toBe('Untitled note');
    expect((await loadNote(db, 'owner', 'note'))?.title).toBe('Untitled note');
    const list = await app.request('/api/notes', undefined, { DB: db } as Bindings);
    expect(((await list.json()) as { title: string }[])[0]?.title).toBe('Untitled note');
  });

  it('uses a legacy conversation title when the stored note title is blank', async () => {
    const { db } = await fixture();
    await db.prepare("UPDATE notes SET title='' WHERE id='note'").run();
    await db
      .prepare(
        "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','note','Legacy title','now','2999-01-01','active','now')",
      )
      .run();

    expect((await selectNote(db, 'owner', 'note'))?.title).toBe('Legacy title');
    expect((await loadNoteState(db, 'owner', 'note')).note.title).toBe('Legacy title');
    expect((await loadNote(db, 'owner', 'note'))?.title).toBe('Legacy title');
  });

  it('preserves null for an unlinked note and 404 for a missing linked note', async () => {
    const { db } = await fixture();
    expect(await loadNote(db, 'owner', null)).toBeNull();
    await expect(loadNote(db, 'owner', 'missing-note')).rejects.toMatchObject({ status: 404 });
    await expect(loadNoteState(db, 'owner', 'missing-note')).rejects.toMatchObject({ status: 404 });
  });
});
