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
  icon?: Persona['icon'] | null;
  replaces_persona_id?: string | null;
};
const map = ({ replaces_persona_id: replaces, icon, ...row }: PersonaRow): Persona => ({
  ...row,
  icon: icon ?? DEFAULT_PERSONAS.find((p) => p.id === replaces)?.icon ?? 'user',
});
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
        'SELECT id,name,prompt,brevity,challenge,tone,revision,icon,replaces_persona_id FROM personas WHERE owner_id=? ORDER BY updated_at DESC',
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
    'INSERT INTO personas (id,owner_id,name,prompt,brevity,challenge,tone,revision,icon,created_at,updated_at,replaces_persona_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
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
      persona.icon ?? null,
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
      'SELECT id,name,prompt,brevity,challenge,tone,revision,icon FROM personas WHERE id=? AND owner_id=?',
    ).bind(c.req.param('id'), c.get('userId')),
  );
  if (!current) throw new HttpError(404, 'Persona not found');
  const next = { ...current, ...parsed.data, revision: current.revision + 1 };
  await c.env.DB.prepare(
    'UPDATE personas SET name=?,prompt=?,brevity=?,challenge=?,tone=?,revision=?,icon=?,updated_at=? WHERE id=? AND owner_id=?',
  )
    .bind(
      next.name,
      next.prompt,
      next.brevity,
      next.challenge,
      next.tone,
      next.revision,
      next.icon ?? null,
      nowIso(),
      current.id,
      c.get('userId'),
    )
    .run();
  return c.json(map(next));
});
// Check remaining choices in the mutation itself so concurrent deletes cannot
// both succeed after observing the same list. Built-ins live outside the DB.
const remainingPersona = `(
  EXISTS (SELECT 1 FROM personas WHERE owner_id=? AND id<>?)
  OR EXISTS (
    SELECT value FROM json_each(?) AS defaults
    WHERE value<>? AND NOT EXISTS (
      SELECT 1 FROM hidden_personas WHERE owner_id=? AND persona_id=defaults.value
    )
  )
)`;
const defaultIds = JSON.stringify(DEFAULT_PERSONAS.map((p) => p.id));

personaRoutes.delete('/:id', async (c) => {
  const owner = c.get('userId');
  const id = c.req.param('id');
  if (DEFAULT_PERSONAS.some((persona) => persona.id === id)) {
    const result = await c.env.DB.prepare(
      `INSERT INTO hidden_personas (owner_id,persona_id,created_at)
       SELECT ?,?,? WHERE ${remainingPersona}
       ON CONFLICT(owner_id,persona_id) DO NOTHING`,
    )
      .bind(owner, id, nowIso(), owner, id, defaultIds, id, owner)
      .run();
    if (!result.meta.changes) {
      const hidden = await first(
        c.env.DB.prepare(
          'SELECT persona_id FROM hidden_personas WHERE owner_id=? AND persona_id=?',
        ).bind(owner, id),
      );
      if (!hidden) throw new HttpError(409, 'Keep at least one persona.');
    }
    return c.body(null, 204);
  }
  const result = await c.env.DB.prepare(
    `DELETE FROM personas WHERE id=? AND owner_id=? AND ${remainingPersona}`,
  )
    .bind(id, owner, owner, id, defaultIds, id, owner)
    .run();
  if (result.meta.changes !== 1) {
    const existing = await first(
      c.env.DB.prepare('SELECT id FROM personas WHERE id=? AND owner_id=?').bind(id, owner),
    );
    if (existing) throw new HttpError(409, 'Keep at least one persona.');
    throw new HttpError(404, 'Persona not found');
  }
  return c.body(null, 204);
});
