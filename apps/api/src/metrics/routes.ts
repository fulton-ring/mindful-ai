import type { Usage } from '@walden/contracts';
import { Hono } from 'hono';
import { loadMessageBudget, messageLimitFrom } from '../chat/turns/message-limit';
import { first } from '../db/client';
import type { Bindings, Variables } from '../types';

export const metricsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
/** The message budget alone, which the composer checks after every reply. */
metricsRoutes.get('/budget', async (c) =>
  c.json(await loadMessageBudget(c.env.DB, c.get('userId'), messageLimitFrom(c.env))),
);
metricsRoutes.get('/usage', async (c) => {
  const ownerId = c.get('userId');
  const [budget, sent, favorite] = await Promise.all([
    loadMessageBudget(c.env.DB, ownerId, messageLimitFrom(c.env)),
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
        `SELECT json_extract(ui_message,'$.metadata.personaName') AS persona_name FROM messages
         WHERE owner_id=? AND role='assistant' AND persona_name IS NOT NULL
         GROUP BY persona_name ORDER BY COUNT(DISTINCT conversation_id) DESC, MAX(created_at) DESC LIMIT 1`,
      ).bind(ownerId),
    ),
  ]);
  return c.json({
    budget,
    messagesSent: sent?.total ?? 0,
    favoritePersona: favorite?.persona_name ?? null,
  } satisfies Usage);
});
