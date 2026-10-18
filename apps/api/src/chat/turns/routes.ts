import {
  type ChatRequest,
  chatRequestSchema,
  type MessageBudget,
  type TurnStart,
} from '@walden/contracts';
import { type Context, Hono } from 'hono';
import { first, parseJson } from '../../db/client';
import type { AppDatabase } from '../../db/database';
import { HttpError, jsonBody, nowIso } from '../../http';
import { getPublicInferenceConfig, validateInferenceModel } from '../../inference/config';
import { captureServerEvent } from '../../observability';
import { modelNameForPersona } from '../../services/agent/agent';
import type { Bindings, Variables } from '../../types';
import {
  attachmentKey,
  loadAttachments,
  MAX_ATTACHMENT_BYTES,
  stagingAttachmentKey,
  validateAttachmentFile,
} from '../attachments/attachments';
import {
  attachmentMimeType,
  completeUpload,
  presignUpload,
  validateAttachmentBytes,
} from '../attachments/presign';
import { requireConversation } from '../conversations/repository';
import { parseStoredMessage } from '../messages';
import { limitWindowStats, loadMessageBudget, messageLimitFrom } from './message-limit';
import { type PreparedTurn, prepareTurn } from './turn-lifecycle';
import { turnObject } from './turn-session';
import type { TurnRow } from './turn-store';
export const chatRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

chatRoutes.post('/attachments/:conversationId/initiate', async (c) => {
  if (!c.env.FILES) throw new HttpError(503, 'File uploads are unavailable.');
  const conversationId = c.req.param('conversationId');
  const ownerId = c.get('userId');
  await requireConversation(c.env.DB, ownerId, conversationId);
  const body = await jsonBody<{ name?: string; mimeType?: string; size?: number }>(c);
  if (
    !body.name ||
    body.name.length > 180 ||
    !Number.isInteger(body.size) ||
    (body.size ?? 0) < 1 ||
    (body.size ?? 0) > MAX_ATTACHMENT_BYTES
  )
    throw new HttpError(413, 'Files must be between 1 byte and 1 MB.');
  const mimeType = attachmentMimeType(body.name, body.mimeType ?? '');
  const id = crypto.randomUUID();
  if (c.env.FILES.presignPut) {
    const uploadUrl = await c.env.FILES.presignPut(
      stagingAttachmentKey(ownerId, conversationId, id),
      mimeType,
      120,
    );
    return c.json({ id, mode: 'presigned', uploadUrl, headers: { 'Content-Type': mimeType } });
  }
  if (c.env.FILES.uploadMode === 'direct') return c.json({ id, mode: 'local' });
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = c.env;
  if (R2_ACCOUNT_ID && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    const uploadUrl = await presignUpload(
      {
        accountId: R2_ACCOUNT_ID,
        bucket: R2_BUCKET,
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      ownerId,
      conversationId,
      id,
      mimeType,
    );
    return c.json({ id, mode: 'presigned', uploadUrl, headers: { 'Content-Type': mimeType } });
  }
  if (c.env.UPLOAD_LOCAL_FALLBACK === 'true') return c.json({ id, mode: 'local' });
  throw new HttpError(503, 'R2 upload signing is not configured.');
});

chatRoutes.post('/attachments/:conversationId/:attachmentId/complete', async (c) => {
  if (!c.env.FILES) throw new HttpError(503, 'File uploads are unavailable.');
  const conversationId = c.req.param('conversationId');
  const ownerId = c.get('userId');
  await requireConversation(c.env.DB, ownerId, conversationId);
  const id = c.req.param('attachmentId');
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Uploaded file not found.');
  const body = await jsonBody<{ name?: string }>(c);
  if (!body.name || body.name.length > 180) throw new HttpError(400, 'Invalid file name.');
  return c.json(await completeUpload(c.env.FILES, ownerId, conversationId, id, body.name));
});

chatRoutes.post('/attachments/:conversationId', async (c) => {
  if (c.env.FILES?.uploadMode !== 'direct' && c.env.UPLOAD_LOCAL_FALLBACK !== 'true')
    throw new HttpError(404, 'Not found.');
  if (!c.env.FILES) throw new HttpError(503, 'File uploads are unavailable.');
  const conversationId = c.req.param('conversationId');
  const ownerId = c.get('userId');
  await requireConversation(c.env.DB, ownerId, conversationId);
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new HttpError(400, 'Choose a file to upload.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ATTACHMENT_BYTES + 65_536) {
      await reader.cancel();
      throw new HttpError(413, 'Files must be between 1 byte and 1 MB.');
    }
    chunks.push(value);
  }
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const form = await new Response(payload, {
    headers: { 'content-type': c.req.header('content-type') ?? '' },
  }).formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Choose a file to upload.');
  validateAttachmentFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = crypto.randomUUID();
  const name = file.name.slice(0, 180);
  const mimeType = attachmentMimeType(name, file.type);
  validateAttachmentBytes(bytes, mimeType);
  await c.env.FILES.put(attachmentKey(ownerId, conversationId, id), bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { name },
  });
  return c.json({ id, name, mimeType, size: bytes.byteLength });
});

chatRoutes.get('/attachments/:conversationId/:attachmentId', async (c) => {
  if (!c.env.FILES) throw new HttpError(503, 'Files are unavailable.');
  const conversationId = c.req.param('conversationId');
  const attachmentId = c.req.param('attachmentId');
  if (!/^[a-f0-9-]{36}$/.test(attachmentId)) throw new HttpError(404, 'File not found.');
  const ownerId = c.get('userId');
  const owned = await c.env.DB.prepare('SELECT id FROM conversations WHERE id=? AND owner_id=?')
    .bind(conversationId, ownerId)
    .first();
  if (!owned) throw new HttpError(404, 'File not found.');
  const object = await c.env.FILES.get(attachmentKey(ownerId, conversationId, attachmentId));
  if (!object) throw new HttpError(404, 'File not found.');
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

type ChatContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/** Telemetry must not delay the response; tests call the app without an execution context. */
function inBackground(c: ChatContext, task: Promise<void>) {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

/** The send that used up the budget, and sends refused because of it. */
function captureLimit(
  c: ChatContext,
  event: 'message_limit_reached' | 'message_limit_blocked',
  budget: MessageBudget,
  model: string | null,
  weight: number,
) {
  const ownerId = c.get('userId');
  inBackground(
    c,
    limitWindowStats(c.env.DB, ownerId, budget)
      .then((stats) =>
        captureServerEvent(c.env, event, c.get('authSubject'), {
          ...stats,
          model: model ?? 'default',
          weight,
        }),
      )
      .catch(() => undefined),
  );
}

/** The budget after an admitted turn's charge; the send that used it up is recorded. */
async function chargedBudget(c: ChatContext, turn: PreparedTurn) {
  const budget = await loadMessageBudget(c.env.DB, c.get('userId'), messageLimitFrom(c.env));
  if (budget.used >= budget.limit && budget.used - turn.weight < budget.limit)
    captureLimit(c, 'message_limit_reached', budget, turn.model, turn.weight);
  return budget;
}

async function recordRefusal(c: ChatContext, error: unknown) {
  const details =
    error instanceof HttpError ? (error.details as { code?: string; weight?: number }) : null;
  if (details?.code !== 'message_limit') return;
  const budget = await loadMessageBudget(c.env.DB, c.get('userId'), messageLimitFrom(c.env));
  captureLimit(c, 'message_limit_blocked', budget, null, details.weight ?? 1);
}

/** Starts an admitted turn in its object; a turn already started there is left as it is. */
const startTurn = (env: Bindings, turnId: string) => turnObject(env, turnId).start(turnId);

async function findOwnedTurn(db: AppDatabase, ownerId: string, id: string) {
  return first<TurnRow>(
    db
      .prepare(
        'SELECT * FROM turns WHERE owner_id=? AND (id=? OR request_id=?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1',
      )
      .bind(ownerId, id, id, id),
  );
}

/** What the turn's object needs to run it; attachment bytes are reloaded there. */
function turnInput(
  ownerId: string,
  telemetryUserId: string,
  request: ChatRequest,
  turn: PreparedTurn,
) {
  return {
    ownerId,
    telemetryUserId,
    turnId: turn.turnId,
    requestId: request.requestId,
    conversation: turn.conversation,
    note: turn.note,
    persona: turn.persona,
    message: turn.requestMessage,
    attachments: (turn.attachments ?? []).map(({ id, name, mimeType, size }) => ({
      id,
      name,
      mimeType,
      size,
    })),
    action: request.action,
    pendingIntervention: turn.pendingIntervention,
    userMessageId: turn.userMessageId,
    forked: turn.branchFork,
  };
}

async function admissionRuntime(c: ChatContext, ownerId: string) {
  const catalog = await getPublicInferenceConfig(c.env);
  if (!catalog.configured) throw new HttpError(503, 'AI inference is not configured.');
  const models = new Map(catalog.models.map((model) => [model.id, model]));
  return {
    db: c.env.DB,
    ownerId,
    messageLimit: messageLimitFrom(c.env),
    modelWeightFor: (model: string) => models.get(model)?.weight ?? 1,
    modelFor: (persona: import('@walden/contracts').Persona) => {
      const model = modelNameForPersona(c.env, persona);
      return validateInferenceModel(model, catalog).id;
    },
  };
}

chatRoutes.post('/turns', async (c) => {
  const parsed = chatRequestSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid chat request', parsed.error.flatten());
  const request = parsed.data;
  const ownerId = c.get('userId');
  const requestJson = JSON.stringify(request);
  const previous = await findOwnedTurn(c.env.DB, ownerId, request.requestId);
  if (previous) {
    if (previous.request_json !== requestJson)
      throw new HttpError(409, 'Request ID was already used for a different turn.');
    await startTurn(c.env, previous.id);
    return c.json({
      turnId: previous.id,
      userMessageId: previous.user_message_id,
    } satisfies TurnStart);
  }
  const attachments = request.attachmentIds?.length
    ? await loadAttachments(
        c.env.FILES ??
          (() => {
            throw new HttpError(503, 'File uploads are unavailable.');
          })(),
        ownerId,
        request.conversationId,
        request.attachmentIds,
      )
    : [];
  const runtime = await admissionRuntime(c, ownerId);
  let result: Awaited<ReturnType<typeof prepareTurn>>;
  try {
    result = await prepareTurn(runtime, request, attachments);
  } catch (error) {
    await recordRefusal(c, error);
    const concurrent = await findOwnedTurn(c.env.DB, ownerId, request.requestId);
    if (!concurrent || concurrent.request_json !== requestJson) throw error;
    await startTurn(c.env, concurrent.id);
    return c.json({
      turnId: concurrent.id,
      userMessageId: concurrent.user_message_id,
    } satisfies TurnStart);
  }
  if (result.kind === 'replay') {
    const replay = await findOwnedTurn(c.env.DB, ownerId, request.requestId);
    if (!replay) throw new HttpError(409, 'The previous turn is unavailable.');
    return c.json({ turnId: replay.id, userMessageId: replay.user_message_id } satisfies TurnStart);
  }
  const turn = result.turn;
  const input = turnInput(ownerId, c.get('authSubject'), request, turn);
  const row = await first<TurnRow>(
    c.env.DB.prepare(
      "UPDATE turns SET input_json=?,request_json=?,user_message_id=? WHERE id=? AND owner_id=? AND status='streaming' RETURNING *",
    ).bind(JSON.stringify(input), requestJson, turn.userMessageId, turn.turnId, ownerId),
  );
  if (!row) throw new HttpError(500, 'Turn admission failed.');
  try {
    await startTurn(c.env, row.id);
  } catch {
    /* Minute reconciliation starts an admitted turn the object never received. */
  }
  return c.json({
    turnId: turn.turnId,
    userMessageId: turn.userMessageId,
    budget: await chargedBudget(c, turn),
  } satisfies TurnStart);
});

chatRoutes.get('/turns', async (c) => {
  const conversationId = c.req.query('conversationId');
  const branchId = c.req.query('branchId');
  if (!conversationId || !branchId)
    throw new HttpError(400, 'Conversation and branch are required.');
  await requireConversation(c.env.DB, c.get('userId'), conversationId, branchId);
  const row = await first<TurnRow>(
    c.env.DB.prepare(
      "SELECT * FROM turns WHERE conversation_id=? AND owner_id=? AND status='streaming' AND (branch_id=? OR source_branch_id=?) ORDER BY created_at DESC LIMIT 1",
    ).bind(conversationId, c.get('userId'), branchId, branchId),
  );
  if (!row) return c.json({ turn: null });
  await startTurn(c.env, row.id).catch(() => undefined);
  const request = parseJson<{ regenerateMessageId?: string; editMessageId?: string }>(
    row.request_json,
    {},
  );
  const userMessage = row.user_message_id
    ? await first<{ ui_message: string }>(
        c.env.DB.prepare(`SELECT m.ui_message FROM turns t JOIN messages m
          ON m.id=t.user_message_id AND m.owner_id=t.owner_id AND m.conversation_id=t.conversation_id
          WHERE t.id=? AND t.owner_id=? AND t.conversation_id=? AND m.role='user'`).bind(
          row.id,
          c.get('userId'),
          conversationId,
        ),
      )
    : null;
  return c.json({
    turn: {
      id: row.id,
      requestId: row.request_id,
      conversationId: row.conversation_id,
      branchId: row.branch_id,
      userMessageId: row.user_message_id,
      ...(userMessage ? { userMessage: parseStoredMessage(userMessage.ui_message) } : {}),
      ...(request.regenerateMessageId ? { regenerateMessageId: request.regenerateMessageId } : {}),
      ...(request.editMessageId ? { editMessageId: request.editMessageId } : {}),
    },
  });
});

chatRoutes.get('/turns/:id/events', async (c) => {
  const row = await findOwnedTurn(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!row) throw new HttpError(404, 'Turn not found');
  if (c.req.header('X-Walden-Turn-Protocol') !== '2')
    throw new HttpError(409, 'Reload the app to reconnect to this reply.', {
      code: 'turn_protocol',
      action: 'reload',
    });
  const cursor = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, 'Invalid event cursor');
  return turnObject(c.env, row.id).stream(row.id, cursor);
});

chatRoutes.post('/turns/:id/cancel', async (c) => {
  const ownerId = c.get('userId');
  const id = c.req.param('id');
  const before = await findOwnedTurn(c.env.DB, ownerId, id);
  await c.env.DB.prepare(
    'INSERT INTO turn_cancellations(owner_id,request_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
  )
    .bind(ownerId, before?.request_id ?? id, nowIso())
    .run();
  const row = await findOwnedTurn(c.env.DB, ownerId, id);
  if (!row) return c.json({ cancelled: true });
  if (row.status !== 'streaming') return c.json({ cancelled: false });
  return c.json({ cancelled: await turnObject(c.env, row.id).stop(row.id) });
});
