import {
  DEFAULT_PERSONAS,
  PRODUCT_EVENT_KINDS,
  type ProductEvent,
  type Usage,
} from '@walden/contracts';
import { Hono } from 'hono';
import { first } from '../db/client';
import { HttpError, jsonBody, newId, nowIso } from '../http';
import type { Bindings, Variables } from '../types';

type UsageRow = {
  plan: Usage['plan'];
  used: number;
  unit_limit: number;
  resets_at: string;
  input_tokens: number;
  output_tokens: number;
};
const resetDate = (plan: Usage['plan']) => {
  const date = new Date();
  if (plan === 'free') date.setUTCDate(date.getUTCDate() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1, 1);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};
export const metricsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
metricsRoutes.get('/usage', async (c) => {
  const ownerId = c.get('userId');
  let row = await first<UsageRow>(
    c.env.DB.prepare(
      'SELECT plan,used,unit_limit,resets_at,input_tokens,output_tokens FROM usage_periods WHERE owner_id=?',
    ).bind(ownerId),
  );
  if (!row || row.resets_at <= nowIso()) {
    const plan = row?.plan ?? 'free';
    const resetsAt = resetDate(plan);
    await c.env.DB.prepare(
      "INSERT INTO usage_periods (owner_id,plan,used,unit_limit,resets_at,input_tokens,output_tokens) VALUES (?,'free',0,10,?,0,0) ON CONFLICT(owner_id) DO UPDATE SET used=0,resets_at=excluded.resets_at,input_tokens=0,output_tokens=0",
    )
      .bind(ownerId, resetsAt)
      .run();
    row = {
      plan,
      used: 0,
      unit_limit: plan === 'personal' ? 500 : 10,
      resets_at: resetsAt,
      input_tokens: 0,
      output_tokens: 0,
    };
  }
  const [sent, favorite] = await Promise.all([
    first<{ total: number }>(
      c.env.DB.prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE owner_id=? AND role='user'",
      ).bind(ownerId),
    ),
    // Which persona this account actually works with, by thread count. The
    // persona snapshot carries the name it had at the time, so a renamed or
    // deleted persona still reports something meaningful.
    first<{ persona_id: string | null; snapshot: string | null }>(
      c.env.DB.prepare(
        `SELECT persona_id, MAX(persona_snapshot_json) AS snapshot FROM conversations
         WHERE owner_id=? AND persona_id IS NOT NULL
         GROUP BY persona_id ORDER BY COUNT(*) DESC, MAX(last_user_activity_at) DESC LIMIT 1`,
      ).bind(ownerId),
    ),
  ]);
  const personaName = (() => {
    if (!favorite?.persona_id) return null;
    try {
      const snapshot = favorite.snapshot ? JSON.parse(favorite.snapshot) : null;
      if (snapshot && typeof snapshot.name === 'string' && snapshot.name.trim())
        return snapshot.name as string;
    } catch {
      // Fall through to the built-in name below.
    }
    return DEFAULT_PERSONAS.find((p) => p.id === favorite.persona_id)?.name ?? null;
  })();
  return c.json({
    plan: row.plan,
    used: row.used,
    limit: row.unit_limit,
    resetsAt: row.resets_at,
    provider: c.env.AI_PROVIDER ?? 'unavailable',
    model: c.env.AI_MODEL ?? 'unavailable',
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    messagesSent: sent?.total ?? 0,
    favoritePersona: personaName,
  } satisfies Usage);
});

const allowedEvents = new Set<string>(PRODUCT_EVENT_KINDS);
metricsRoutes.post('/events', async (c) => {
  const body = await jsonBody<Partial<ProductEvent>>(c);
  if (!body.sessionId || !body.kind || !allowedEvents.has(body.kind))
    throw new HttpError(400, 'Invalid product event');
  const metadata = body.metadata ?? {};
  if (
    Object.keys(metadata).length > 20 ||
    Object.values(metadata).some((value) => typeof value === 'string' && value.length > 120)
  )
    throw new HttpError(400, 'Event metadata exceeds limits');
  await c.env.DB.prepare(
    'INSERT INTO product_events (id,owner_id,session_id,kind,metadata_json,occurred_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
  )
    .bind(
      body.id ?? newId(),
      c.get('userId'),
      body.sessionId,
      body.kind,
      JSON.stringify(metadata),
      body.occurredAt ?? nowIso(),
    )
    .run();
  return c.json({ accepted: true }, 202);
});
