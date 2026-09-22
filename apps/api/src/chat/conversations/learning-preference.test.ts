import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { sqliteD1Binding } from '../../agent/memory/d1-test-binding';
import { HttpError } from '../../http';
import type { Bindings, Variables } from '../../types';
import { conversationRoutes } from './conversations';

it.each([
  ['learning-checks', 'learningChecksEnabled'],
  ['web-search', 'webSearchEnabled'],
])('persists %s and rejects invalid or unowned updates', async (route, field) => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-learning-'));
  try {
    const file = join(directory, 'test.sqlite');
    const migrations = new URL('../../../migrations/', import.meta.url);
    execFileSync('sqlite3', [file], {
      input: readdirSync(migrations)
        .filter((n) => n.endsWith('.sql'))
        .sort()
        .map((n) => readFileSync(new URL(n, migrations), 'utf8'))
        .join('\n'),
    });
    const DB = sqliteD1Binding(file);
    await DB.prepare(
      "INSERT INTO users VALUES ('owner','subject','now','now',0),('other','other','now','now',0)",
    ).run();
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('userId', 'owner');
      await next();
    });
    app.onError((error, c) =>
      c.json({ error: error.message }, error instanceof HttpError ? error.status : 500),
    );
    app.route('/api', conversationRoutes);
    const env = { DB } as Bindings;
    const created = await app.request(
      '/api/conversations',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    const conversation = (await created.json()) as { id: string } & Record<string, unknown>;
    expect(conversation[field]).toBe(true);
    const update = (enabled: unknown) =>
      app.request(
        `/api/conversations/${conversation.id}/${route}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
        env,
      );
    for (const enabled of [false, true]) {
      expect((await update(enabled)).status).toBe(200);
      const response = await app.request(`/api/conversations/${conversation.id}`, {}, env);
      expect(((await response.json()) as Record<string, unknown>)[field]).toBe(enabled);
    }
    expect((await update('false')).status).toBe(400);
    await DB.prepare('UPDATE conversations SET owner_id=? WHERE id=?')
      .bind('other', conversation.id)
      .run();
    expect((await update(false)).status).toBe(404);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
