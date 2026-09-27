import { DEFAULT_PERSONAS, personaSchema } from '@walden/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, first } from '../db/client';
import { HttpError, newId, nowIso, parseBody } from '../http';
import type { Bindings, Variables } from '../types';
import { loadPersonaRow, PERSONA_COLUMNS, type PersonaRow, toPersona } from './repository';

const personaFieldsSchema = personaSchema.omit({ id: true });
const createSchema = personaFieldsSchema.extend({
  replacesPersonaId: z.string().min(1).optional(),
});
// Which built-in a persona replaces is fixed at creation; a patch cannot move it.
const updateSchema = personaFieldsSchema.partial();
export const personaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

personaRoutes.get('/', async (c) => {
  const ownerId = c.get('userId');
  const [hiddenRows, customRows] = await Promise.all([
    all<{ persona_id: string }>(
      c.env.DB.prepare('SELECT persona_id FROM hidden_personas WHERE owner_id=?').bind(ownerId),
    ),
    all<PersonaRow>(
      c.env.DB.prepare(
        `SELECT ${PERSONA_COLUMNS} FROM personas WHERE owner_id=? ORDER BY updated_at DESC`,
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
    if (override) return [toPersona(override)];
    return hidden.has(persona.id) ? [] : [persona];
  });
  return c.json([...slots, ...customRows.filter((row) => !row.replaces_persona_id).map(toPersona)]);
});
personaRoutes.post('/', async (c) => {
  const { replacesPersonaId, ...values } = await parseBody(c, createSchema, 'Invalid persona');
  const replaces =
    replacesPersonaId && DEFAULT_PERSONAS.some((persona) => persona.id === replacesPersonaId)
      ? replacesPersonaId
      : null;
  const row: PersonaRow = {
    id: newId(),
    ...values,
    model: values.model ?? null,
    icon: values.icon ?? null,
    replaces_persona_id: replaces,
  };
  const now = nowIso();
  await c.env.DB.prepare(
    'INSERT INTO personas (id,owner_id,name,prompt,model,brevity,challenge,tone,icon,created_at,updated_at,replaces_persona_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      row.id,
      c.get('userId'),
      row.name,
      row.prompt,
      row.model,
      row.brevity,
      row.challenge,
      row.tone,
      row.icon,
      now,
      now,
      row.replaces_persona_id,
    )
    .run();
  return c.json(toPersona(row), 201);
});
personaRoutes.patch('/:id', async (c) => {
  const changes = await parseBody(c, updateSchema, 'Invalid persona');
  const current = await loadPersonaRow(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!current) throw new HttpError(404, 'Persona not found');
  const next: PersonaRow = {
    ...current,
    ...changes,
    model: changes.model ?? current.model,
    icon: changes.icon ?? current.icon,
  };
  await c.env.DB.prepare(
    'UPDATE personas SET name=?,prompt=?,model=?,brevity=?,challenge=?,tone=?,icon=?,updated_at=? WHERE id=? AND owner_id=?',
  )
    .bind(
      next.name,
      next.prompt,
      next.model,
      next.brevity,
      next.challenge,
      next.tone,
      next.icon,
      nowIso(),
      current.id,
      c.get('userId'),
    )
    .run();
  return c.json(toPersona(next));
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
