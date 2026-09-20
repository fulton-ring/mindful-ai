import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Persona } from '@walden/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../agent/d1-test-binding';
import type { Bindings, Variables } from '../types';
import { personaRoutes } from './routes';

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-persona-override-')), 'personas.sqlite');
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
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api/personas', personaRoutes);
  const list = async (): Promise<Persona[]> =>
    (await app.request('/api/personas', {}, { DB: db } as Bindings)).json();
  return { app, db, list };
}

describe('persona list ordering', () => {
  it('lists the built-ins in order before anything is edited', async () => {
    const { list } = await fixture();
    expect((await list()).map((p) => p.name)).toEqual(['Mentor', 'Critical reader']);
  });

  it('keeps an edited built-in in its original slot instead of appending a duplicate', async () => {
    const { app, db, list } = await fixture();
    const created = await app.request(
      '/api/personas',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Mentor',
          prompt: 'Edited guidance.',
          brevity: 'brief',
          challenge: 'balanced',
          tone: 'neutral',
          replacesPersonaId: 'thinking-partner',
        }),
      },
      { DB: db } as Bindings,
    );
    expect(created.status).toBe(201);
    await app.request('/api/personas/thinking-partner', { method: 'DELETE' }, {
      DB: db,
    } as Bindings);

    const personas = await list();
    // One Mentor, still first, now carrying the edited prompt.
    expect(personas.map((p) => p.name)).toEqual(['Mentor', 'Critical reader']);
    expect(personas[0]?.prompt).toBe('Edited guidance.');
    expect(personas[0]?.id).not.toBe('thinking-partner');
  });

  it('appends a genuinely new persona after the built-ins', async () => {
    const { app, db, list } = await fixture();
    await app.request(
      '/api/personas',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Editor',
          prompt: 'Tighten prose.',
          brevity: 'brief',
          challenge: 'gentle',
          tone: 'warm',
        }),
      },
      { DB: db } as Bindings,
    );
    expect((await list()).map((p) => p.name)).toEqual(['Mentor', 'Critical reader', 'Editor']);
  });
});
