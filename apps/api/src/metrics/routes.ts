import type { Usage } from '@walden/contracts';
import { Hono } from 'hono';
import { first } from '../db/client';
import type { Bindings, Variables } from '../types';

export const metricsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
metricsRoutes.get('/usage', async (c) => {
  const ownerId = c.get('userId');
  const [sent, favorite] = await Promise.all([
    first<{ total: number }>(
      c.env.DB.prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE owner_id=? AND role='user'",
      ).bind(ownerId),
    ),
    // Which persona this account actually works with, by thread count. Each
    // reply records the persona name it was written with, so a renamed or
    // deleted persona still reports something meaningful.
    first<{ persona_name: string }>(
      c.env.DB.prepare(
        `SELECT persona_name FROM messages
         WHERE owner_id=? AND role='assistant' AND persona_name IS NOT NULL
         GROUP BY persona_name ORDER BY COUNT(DISTINCT conversation_id) DESC, MAX(created_at) DESC LIMIT 1`,
      ).bind(ownerId),
    ),
  ]);
  return c.json({
    messagesSent: sent?.total ?? 0,
    favoritePersona: favorite?.persona_name ?? null,
  } satisfies Usage);
});
