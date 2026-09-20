import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Persona } from '@walden/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sqliteD1Binding } from '../agent/d1-test-binding';
import { HttpError } from '../http';
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
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ error: error.message }, error.status) : c.json({}, 500),
  );
  const list = async (): Promise<Persona[]> =>
    (await app.request('/api/personas', {}, { DB: db } as Bindings)).json();
  return { app, db, list };
}

describe('persona list ordering', () => {
  it('lists the built-ins in order before anything is edited', async () => {
    const { list } = await fixture();
    expect((await list()).map((p) => p.name)).toEqual(['Mentor', 'Challenger', 'Study partner']);
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
    expect(personas.map((p) => p.name)).toEqual(['Mentor', 'Challenger', 'Study partner']);
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
    expect((await list()).map((p) => p.name)).toEqual([
      'Mentor',
      'Challenger',
      'Study partner',
      'Editor',
    ]);
  });
});

it('persists an icon on create and edit, and preserves it when omitted from a patch', async () => {
  const { app, db, list } = await fixture();
  const request = (path: string, method: string, body: object) =>
    app.request(
      path,
      { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      { DB: db } as Bindings,
    );
  const created = await request('/api/personas', 'POST', {
    name: 'Coach',
    prompt: 'Help me practice.',
    brevity: 'brief',
    challenge: 'balanced',
    tone: 'neutral',
    icon: 'lightbulb',
  });
  const persona = (await created.json()) as Persona & { icon: string };
  expect(persona.icon).toBe('lightbulb');
  expect((await list()).find((p) => p.id === persona.id)).toMatchObject({ icon: 'lightbulb' });
  await request(`/api/personas/${persona.id}`, 'PATCH', { icon: 'book' });
  await request(`/api/personas/${persona.id}`, 'PATCH', { name: 'Reading coach' });
  expect((await list()).find((p) => p.id === persona.id)).toMatchObject({
    name: 'Reading coach',
    icon: 'book',
  });
});

it('rejects deleting the last persona, including simultaneous deletion requests', async () => {
  const { app, db, list } = await fixture();
  const remove = (id: string) =>
    app.request(`/api/personas/${id}`, { method: 'DELETE' }, { DB: db } as Bindings);
  const responses = await Promise.all((await list()).map((p) => remove(p.id)));
  expect(responses.map((r) => r.status).sort()).toEqual([204, 204, 409]);
  expect(await list()).toHaveLength(1);
});

it('protects a last custom persona and ignores other owners personas', async () => {
  const { app, db, list } = await fixture();
  await db.prepare("INSERT INTO users VALUES ('other','other','now','now',0)").run();
  for (const owner of ['owner', 'other']) {
    await db
      .prepare(
        "INSERT INTO personas (id,owner_id,name,prompt,brevity,challenge,tone,revision,created_at,updated_at) VALUES (?,?,'Coach','Help','brief','balanced','neutral',0,'now','now')",
      )
      .bind(owner, owner)
      .run();
  }
  for (const p of await list()) {
    if (p.id !== 'owner')
      expect(
        (await app.request(`/api/personas/${p.id}`, { method: 'DELETE' }, { DB: db } as Bindings))
          .status,
      ).toBe(204);
  }
  expect(
    (await app.request('/api/personas/owner', { method: 'DELETE' }, { DB: db } as Bindings)).status,
  ).toBe(409);
  expect(await list()).toHaveLength(1);
});
