import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../agent/d1-test-binding';
import { HttpError } from '../http';
import type { Bindings, Variables } from '../types';
import { notesRoutes } from './routes';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-multiple-suggestions-')), 'notes.sqlite');
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
      "INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner','Keep cash.\\n\\nPlan.',2,'[]','now','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','note','Title','now','2999-01-01','active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,status,last_user_activity_at,expires_at,created_at) VALUES ('branch:conversation','conversation','owner',1,'active','now','2999-01-01','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at,origin_branch_id) VALUES ('source-a','conversation','owner','assistant','Source A',1,'now','branch:conversation'),('source-b','conversation','owner','assistant','Source B',2,'now','branch:conversation')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,base_revision,base_markdown,old_text,new_text,reason,status,created_at,updated_at,branch_id) VALUES ('suggestion-a','note','owner','conversation','source-a',2,'Keep cash.\\n\\nPlan.','Keep cash.','Keep cash. Save three months.','Source A','pending','1','1','branch:conversation'),('suggestion-b','note','owner','conversation','source-b',2,'Keep cash.\\n\\nPlan.','Plan.','Plan. Review monthly.','Source B','pending','2','2','branch:conversation')",
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

  const decide = (
    suggestionId: string,
    decision: 'accept' | 'reject',
    baseRevision: number,
    markdown?: string,
  ) =>
    app.request(
      `/api/notes/note/suggestions/${suggestionId}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          baseRevision,
          operationId: `${decision}-${suggestionId}-${baseRevision}`,
          ...(markdown === undefined ? {} : { markdown }),
        }),
      },
      { DB: db } as Bindings,
    );
  const undo = (baseRevision: number) =>
    app.request(
      '/api/notes/note/undo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision, operationId: `undo-${baseRevision}` }),
      },
      { DB: db } as Bindings,
    );
  return { db, decide, undo };
}

describe('independent note suggestions', () => {
  it('accepts an unchanged anchor from an older view and safely replays the request', async () => {
    const { db, decide } = await fixture();
    expect((await decide('suggestion-a', 'accept', 2)).status).toBe(200);
    expect((await decide('suggestion-b', 'accept', 2)).status).toBe(200);
    expect((await decide('suggestion-b', 'accept', 2)).status).toBe(200);
    expect(await db.prepare("SELECT revision FROM notes WHERE id='note'").first()).toEqual({
      revision: 4,
    });
  });

  it('does not let submitted Markdown bypass a replacement anchor conflict', async () => {
    const { db, decide } = await fixture();
    await db
      .prepare("UPDATE notes SET markdown='A different plan.',revision=3 WHERE id='note'")
      .run();
    const response = await decide(
      'suggestion-b',
      'accept',
      2,
      'A different plan.\n\nPlan. Review monthly.',
    );
    expect(response.status).toBe(409);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: 'A different plan.',
        revision: 3,
      },
    );
  });

  it('still rejects a stale suggestion whose anchor was changed', async () => {
    const { db, decide } = await fixture();
    await db
      .prepare("UPDATE notes SET markdown='A different plan.',revision=3 WHERE id='note'")
      .run();
    expect((await decide('suggestion-b', 'accept', 2)).status).toBe(409);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      { markdown: 'A different plan.', revision: 3 },
    );
  });

  it('accepts each source independently, then undoes only the latest acceptance', async () => {
    const { db, decide, undo } = await fixture();

    expect((await decide('suggestion-a', 'accept', 2)).status).toBe(200);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: 'Keep cash. Save three months.\\n\\nPlan.',
        revision: 3,
      },
    );
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'suggestion-a', status: 'accepted' },
        { id: 'suggestion-b', status: 'pending' },
      ],
    });

    expect((await decide('suggestion-b', 'accept', 3)).status).toBe(200);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: 'Keep cash. Save three months.\\n\\nPlan. Review monthly.',
        revision: 4,
      },
    );

    expect((await undo(4)).status).toBe(200);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: 'Keep cash. Save three months.\\n\\nPlan.',
        revision: 5,
      },
    );
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'suggestion-a', status: 'accepted' },
        { id: 'suggestion-b', status: 'pending' },
      ],
    });
  });

  it('rejects one source without rejecting the other pending source', async () => {
    const { db, decide } = await fixture();

    expect((await decide('suggestion-a', 'reject', 2)).status).toBe(200);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      { markdown: 'Keep cash.\\n\\nPlan.', revision: 3 },
    );
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'suggestion-a', status: 'dismissed' },
        { id: 'suggestion-b', status: 'pending' },
      ],
    });
  });

  it('accepts and independently undoes sibling suggestions created from an empty note', async () => {
    const { db, decide, undo } = await fixture();
    await db.prepare("UPDATE notes SET markdown='' WHERE id='note'").run();
    await db
      .prepare(
        "UPDATE note_suggestions SET base_markdown='',old_text='',new_text=CASE id WHEN 'suggestion-a' THEN 'First.' ELSE 'Second.' END",
      )
      .run();

    expect((await decide('suggestion-a', 'accept', 2)).status).toBe(200);
    expect((await decide('suggestion-b', 'accept', 3)).status).toBe(200);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: 'First.\n\nSecond.',
        revision: 4,
      },
    );

    expect((await undo(4)).status).toBe(200);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: 'First.',
        revision: 5,
      },
    );
    expect((await undo(5)).status).toBe(200);
    expect(await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first()).toEqual(
      {
        markdown: '',
        revision: 6,
      },
    );
    expect(
      await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
    ).toMatchObject({
      results: [
        { id: 'suggestion-a', status: 'pending' },
        { id: 'suggestion-b', status: 'pending' },
      ],
    });
  });

  it('rejects a suggestion when the submitted preview does not check out', async () => {
    const { db, decide } = await fixture();
    const response = await decide('suggestion-a', 'accept', 2, 'Something else entirely.');

    expect(response.status).toBe(409);
    expect(await db.prepare("SELECT markdown FROM notes WHERE id='note'").first()).toEqual({
      markdown: 'Keep cash.\\n\\nPlan.',
    });
    expect(
      await db.prepare("SELECT status FROM note_suggestions WHERE id='suggestion-a'").first(),
    ).toEqual({ status: 'pending' });
  });
});
