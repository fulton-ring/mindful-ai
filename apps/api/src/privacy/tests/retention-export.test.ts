import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { openSqliteDatabase } from '../../platform/node/sqlite';
import { applySqliteMigrations } from '../../platform/node/sqlite-migrations';
import type { Bindings, Variables } from '../../types';
import { accountRoutes } from '../account';

it('exports no-expiry transcripts with null expiry and preserves their messages', async () => {
  const db = openSqliteDatabase(':memory:');
  try {
    await applySqliteMigrations(db, new URL('../../../migrations/', import.meta.url));
    await db.exec(`INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES('owner','owner','now','now');
   INSERT INTO conversations(id,owner_id,last_user_activity_at,expires_at,created_at,retention_disabled) VALUES('chat','owner','now','2000-01-01','now',1);
   INSERT INTO conversation_branches(id,conversation_id,owner_id,created_at) VALUES('branch','chat','owner','now');
   INSERT INTO messages(id,conversation_id,owner_id,role,ui_message,created_at) VALUES('message','chat','owner','user','{}','now');`);
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('userId', 'owner');
      await next();
    });
    app.route('/', accountRoutes);
    const response = await app.request('/account/export', {}, { DB: db } as Bindings);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      conversations: { id: string; expires_at: string | null }[];
      messages: { id: string }[];
    };
    expect(data.conversations).toEqual([expect.objectContaining({ id: 'chat', expires_at: null })]);
    expect(data.messages).toEqual([expect.objectContaining({ id: 'message' })]);
    expect(await db.prepare('SELECT count(*) AS n FROM messages').first()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
