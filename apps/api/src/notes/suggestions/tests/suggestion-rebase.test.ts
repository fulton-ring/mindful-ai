import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../../../agent/memory/tests/d1-test-binding';
import { HttpError } from '../../../http';
import type { Bindings, Variables } from '../../../types';
import { notesRoutes } from '../../routes';

function testApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api/notes', notesRoutes);
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof HttpError ? error.status : 500),
  );
  return app;
}

async function fixture(markdown: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-rebase-')), 'notes.sqlite');
  const migrations = new URL('../../../../migrations/', import.meta.url);
  const schema = readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
    .join('\n');
  execFileSync('sqlite3', [file], { input: schema });
  const db = sqliteD1Binding(file);
  await db
    .prepare(
      "INSERT INTO users(id,auth_subject,created_at,updated_at,deletion_pending) VALUES ('owner','subject','now','now',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at) VALUES ('note','owner',?,2,'[]','now','now')",
    )
    .bind(markdown)
    .run();
  await db
    .prepare(
      "INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','note','Title','now','2999-01-01','active','now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches (id,conversation_id,owner_id,is_default,created_at) VALUES ('branch','conversation','owner',1,'now')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id,conversation_id,owner_id,role,ui_message,created_at,origin_branch_id) VALUES ('source','conversation','owner','assistant',json_object('id','source','role','assistant','parts',json_array(json_object('type','text','text','Source')),'metadata',json_object('createdAt','now')),'now','branch')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,branch_id,generation_key,base_revision,old_text,new_text,reason,status,created_at,updated_at) VALUES ('suggestion','note','owner','conversation','source','branch','source',1,'Keep cash.','Keep cash. Three months of expenses.','Save the target.','pending','1','1')",
    )
    .run();
  const app = testApp();
  return {
    db,
    decide: (decision: 'accept' | 'reject', operationId = `${decision}-1`) =>
      app.request(
        '/api/notes/note/suggestions/suggestion/decision',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision, baseRevision: 2, operationId }),
        },
        { DB: db } as Bindings,
      ),
    undo: () =>
      app.request(
        '/api/notes/note/undo',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseRevision: 3, operationId: 'undo-1' }),
        },
        { DB: db } as Bindings,
      ),
  };
}

describe('suggestions after concurrent note typing', () => {
  it('keeps unrelated typing when accepting the still-unique anchored edit', async () => {
    const { decide } = await fixture('My new intro.\n\nKeep cash.');
    const response = await decide('accept');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      note: { markdown: 'My new intro.\n\nKeep cash. Three months of expenses.', revision: 3 },
    });
  });
  it.each(['Changed the target.', 'Keep cash.\n\nKeep cash.'])(
    'does not apply an overlapping or ambiguous edit: %s',
    async (markdown) => {
      const { decide, db } = await fixture(markdown);
      expect((await decide('accept')).status).toBe(409);
      expect(
        await db.prepare("SELECT markdown,revision FROM notes WHERE id='note'").first(),
      ).toEqual({ markdown, revision: 2 });
    },
  );

  it.each(['accept', 'reject'] as const)(
    'undoes an earlier %s while keeping a newer suggestion pending',
    async (decision) => {
      const { db, decide, undo } = await fixture('Keep cash.');
      expect((await decide(decision)).status).toBe(200);
      await db
        .prepare(
          "INSERT INTO note_suggestions (id,note_id,owner_id,conversation_id,source_message_id,branch_id,generation_key,base_revision,old_text,new_text,reason,status,created_at,updated_at) VALUES ('newer','note','owner','conversation','source','branch','newer',3,'Keep cash.','Keep cash. Newer.','Useful','pending','2','2')",
        )
        .run();

      const response = await undo();

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ note: { markdown: 'Keep cash.' } });
      expect(
        await db.prepare('SELECT id,status FROM note_suggestions ORDER BY id').all(),
      ).toMatchObject({
        results: [
          { id: 'newer', status: 'pending' },
          { id: 'suggestion', status: 'pending' },
        ],
      });
    },
  );
});
