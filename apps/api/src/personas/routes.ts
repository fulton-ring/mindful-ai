import { DEFAULT_PERSONAS, type Persona, personaSchema } from '@walden/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, first } from '../db/client';
import { HttpError, jsonBody, newId, nowIso } from '../http';
import type { Bindings, Variables } from '../types';

type PersonaRow = {
  id: string;
  name: string;
  prompt: string;
  brevity: Persona['brevity'];
  challenge: Persona['challenge'];
  tone: Persona['tone'];
  revision: number;
  replaces_persona_id?: string | null;
};
const map = ({ replaces_persona_id: _replaces, ...row }: PersonaRow): Persona => row;
const inputSchema = personaSchema
  .omit({ id: true, revision: true })
  .extend({ replacesPersonaId: z.string().min(1).optional() });
export const personaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

personaRoutes.get('/', async (c) => {
  const ownerId = c.get('userId');
  const [hiddenRows, customRows] = await Promise.all([
    all<{ persona_id: string }>(
      c.env.DB.prepare('SELECT persona_id FROM hidden_personas WHERE owner_id=?').bind(ownerId),
    ),
    all<PersonaRow>(
      c.env.DB.prepare(
        'SELECT id,name,prompt,brevity,challenge,tone,revision,replaces_persona_id FROM personas WHERE owner_id=? ORDER BY updated_at DESC',
      ).bind(ownerId),
    ),
  ]);
  const hidden = new Set(hiddenRows.map((row) => row.persona_id));
  // Keep a custom persona that overrides a built-in in that built-in's slot, so
  // the order the app relies on for its default persona stays stable.
  const overrides = new Map(
    customRows
      .filter((row) => row.replaces_persona_id)
      .map((row) => [row.replaces_persona_id as string, row]),
  );
  const slots = DEFAULT_PERSONAS.flatMap((persona) => {
    const override = overrides.get(persona.id);
    if (override) return [map(override)];
    return hidden.has(persona.id) ? [] : [persona];
  });
  return c.json([...slots, ...customRows.filter((row) => !row.replaces_persona_id).map(map)]);
});
personaRoutes.post('/', async (c) => {
  const parsed = inputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid persona', parsed.error.flatten());
  const { replacesPersonaId, ...values } = parsed.data;
  const replaces =
    replacesPersonaId && DEFAULT_PERSONAS.some((persona) => persona.id === replacesPersonaId)
      ? replacesPersonaId
      : null;
  const persona: Persona = { id: newId(), revision: 0, ...values };
  const now = nowIso();
  await c.env.DB.prepare(
    'INSERT INTO personas (id,owner_id,name,prompt,brevity,challenge,tone,revision,created_at,updated_at,replaces_persona_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      persona.id,
      c.get('userId'),
      persona.name,
      persona.prompt,
      persona.brevity,
      persona.challenge,
      persona.tone,
      0,
      now,
      now,
      replaces,
    )
    .run();
  return c.json(persona, 201);
});
personaRoutes.patch('/:id', async (c) => {
  const parsed = inputSchema.partial().safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid persona', parsed.error.flatten());
  const current = await first<PersonaRow>(
    c.env.DB.prepare(
      'SELECT id,name,prompt,brevity,challenge,tone,revision FROM personas WHERE id=? AND owner_id=?',
    ).bind(c.req.param('id'), c.get('userId')),
  );
  if (!current) throw new HttpError(404, 'Persona not found');
  const next = { ...current, ...parsed.data, revision: current.revision + 1 };
  await c.env.DB.prepare(
    'UPDATE personas SET name=?,prompt=?,brevity=?,challenge=?,tone=?,revision=?,updated_at=? WHERE id=? AND owner_id=?',
  )
    .bind(
      next.name,
      next.prompt,
      next.brevity,
      next.challenge,
      next.tone,
      next.revision,
      nowIso(),
      current.id,
      c.get('userId'),
    )
    .run();
  return c.json(map(next));
});
personaRoutes.delete('/:id', async (c) => {
  if (DEFAULT_PERSONAS.some((persona) => persona.id === c.req.param('id'))) {
    await c.env.DB.prepare(
      'INSERT INTO hidden_personas (owner_id,persona_id,created_at) VALUES (?,?,?) ON CONFLICT(owner_id,persona_id) DO NOTHING',
    )
      .bind(c.get('userId'), c.req.param('id'), nowIso())
      .run();
    return c.body(null, 204);
  }
  const result = await c.env.DB.prepare('DELETE FROM personas WHERE id=? AND owner_id=?')
    .bind(c.req.param('id'), c.get('userId'))
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'Persona not found');
  return c.body(null, 204);
});
