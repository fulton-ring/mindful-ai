import { chatRequestSchema } from '@walden/contracts';
import { Hono } from 'hono';
import { HttpError, jsonBody, nowIso } from '../http';
import type { Bindings, Variables } from '../types';
import { abortActiveTurn } from './active-turns';
import { prepareTurn } from './turn-lifecycle';
import { createTurnStream } from './turn-stream';
import {
  batchIfAny,
  conversationStreamingDisposition,
  createDurableStream,
  editContext,
  NEXT_USER_SEQUENCE_SQL,
  personaFor,
  REGENERATE_ASSISTANT_SQL,
  regenerationContext,
  sse,
  turnReplayDisposition,
} from './turn-support';

export {
  batchIfAny,
  conversationStreamingDisposition,
  createDurableStream,
  editContext,
  NEXT_USER_SEQUENCE_SQL,
  personaFor,
  REGENERATE_ASSISTANT_SQL,
  regenerationContext,
  turnReplayDisposition,
};

export const chatRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

chatRoutes.post('/turns', async (c) => {
  const parsed = chatRequestSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid chat request', parsed.error.flatten());
  const result = await prepareTurn({ db: c.env.DB, ownerId: c.get('userId') }, parsed.data);
  if (result.kind === 'replay') return replayResponse(result.event);
  const stream = createTurnStream(
    {
      db: c.env.DB,
      ownerId: c.get('userId'),
      env: c.env,
      authSubject: c.get('authSubject'),
      requestSignal: c.req.raw.signal,
      executionCtx: c.executionCtx,
    },
    result.turn,
  );
  return new Response(stream, { headers: streamHeaders() });
});

function replayResponse(event: Parameters<typeof sse>[0]) {
  return new Response(sse(event), {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

function streamHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}

chatRoutes.post('/turns/:id/cancel', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT id,status FROM turns WHERE (id=? OR request_id=?) AND owner_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1',
  )
    .bind(c.req.param('id'), c.req.param('id'), c.get('userId'), c.req.param('id'))
    .first<{ id: string; status: string }>();
  if (!row) throw new HttpError(404, 'Turn not found');
  abortActiveTurn(row.id, 'cancelled');
  if (row.status === 'streaming')
    await c.env.DB.prepare(
      "UPDATE turns SET status='cancelled',completed_at=? WHERE id=? AND owner_id=?",
    )
      .bind(nowIso(), row.id, c.get('userId'))
      .run();
  return c.json({ cancelled: true });
});
