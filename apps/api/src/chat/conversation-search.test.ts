import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { sqliteD1Binding } from '../agent/memory/d1-test-binding';
import type { Bindings, Variables } from '../types';
import { conversationRoutes } from './conversations';

it('searches owned thread titles, messages, and note text while respecting expiry', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-conversation-search-')), 'test.sqlite');
  const schema = readFileSync(
    new URL('../../migrations/0000_baseline.sql', import.meta.url),
    'utf8',
  );
  execFileSync('sqlite3', [file], {
    input: `${schema}
      INSERT INTO users VALUES ('owner','owner-subject','now','now',0);
      INSERT INTO users VALUES ('other','other-subject','now','now',0);
      INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title)
        VALUES ('note','owner','The stroma contains enzymes.',0,'[]','now','now','Botany');
      INSERT INTO conversations (id,owner_id,note_id,title,last_user_activity_at,expires_at,status,created_at) VALUES
        ('message-thread','owner',NULL,'Photosynthesis','now','2999-01-01','active','now'),
        ('note-thread','owner','note','Old title','now','2999-01-01','active','now'),
        ('expired-thread','owner',NULL,'Old','now','2000-01-01','expired','now'),
        ('other-thread','other',NULL,'Private','now','2999-01-01','active','now');
      INSERT INTO messages (id,conversation_id,owner_id,role,content,sequence,created_at) VALUES
        ('m1','message-thread','owner','user','The Calvin cycle fixes carbon.',1,'now'),
        ('m2','expired-thread','owner','user','The Calvin cycle expired.',1,'now'),
        ('m3','other-thread','other','user','The Calvin cycle is private.',1,'now');`,
  });
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api', conversationRoutes);
  const search = async (query: string) => {
    const response = await app.request(
      `/api/conversations?q=${encodeURIComponent(query)}`,
      {},
      {
        DB: sqliteD1Binding(file),
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Array<{ id: string }>;
  };

  expect((await search('CALVIN cycle')).map(({ id }) => id)).toEqual(['message-thread']);
  expect((await search('stroma')).map(({ id }) => id)).toEqual(['note-thread']);
  expect((await search('Botany enzymes')).map(({ id }) => id)).toEqual(['note-thread']);
  expect((await search('photosynthesis')).map(({ id }) => id)).toEqual(['message-thread']);
  expect((await search('private')).map(({ id }) => id)).toEqual([]);
});
